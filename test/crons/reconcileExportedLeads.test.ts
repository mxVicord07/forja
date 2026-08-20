import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { LeadsRepo } from "../../src/db/leads";
import { reconcileExportedLeads, RECONCILE_WINDOW_HOURS } from "../../src/crons/reconcileExportedLeads";

let env: any;
let db: Db;
let leads: LeadsRepo;
let convId: string;

const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  leads = new LeadsRepo(db);
  env = { DB: d1, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "reconcile-test");
  convId = conv.id;
});

afterEach(() => vi.restoreAllMocks());

/** Inserta un lead con created_at explícito para poder simular su edad. */
async function insertLead(intent: string, createdAt: number, opts: { exportedTo?: string } = {}) {
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO leads (id, conversation_id, name, contact, channel_user_id, intent, notes, exported_to, external_id, created_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?)`,
    [
      id,
      convId,
      "5551234567",
      intent,
      opts.exportedTo ?? null,
      opts.exportedTo ? "old-ext-id" : null,
      createdAt,
      createdAt,
    ],
  );
  return id;
}

describe("reconcileExportedLeads cron", () => {
  it("reintenta solo leads sin exportar y dentro de la ventana; un fallo en uno no detiene a los demás", async () => {
    const now = 1_000 * 24 * HOUR;
    const recentUnexported1 = await insertLead("recent-unexported-1", now - 1 * HOUR);
    const recentUnexported2 = await insertLead("recent-unexported-2", now - 2 * HOUR);
    const oldUnexported = await insertLead(
      "old-unexported",
      now - (RECONCILE_WINDOW_HOURS + 1) * HOUR,
    );
    const alreadyExported = await insertLead("already-exported", now - 1 * HOUR, {
      exportedTo: "odoo",
    });

    vi.useFakeTimers();
    vi.setSystemTime(now);

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      // El primer lead exporta bien, el segundo falla (respuesta ok:false).
      if (body.intent === "recent-unexported-1") {
        return new Response(JSON.stringify({ ok: true, odoo_lead_id: 111 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as any);

    await reconcileExportedLeads(env);

    vi.useRealTimers();

    // Solo los 2 leads recientes sin exportar debieron llamar al webhook.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const intentsSent = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as any).body).intent);
    expect(intentsSent.sort()).toEqual(["recent-unexported-1", "recent-unexported-2"]);

    const all = await leads.list(10);
    const byId = new Map(all.map((l) => [l.id, l]));

    expect(byId.get(recentUnexported1)!.exported_to).toBe("odoo");
    expect(byId.get(recentUnexported1)!.external_id).toBe("111");
    expect(byId.get(recentUnexported2)!.exported_to).toBeNull(); // falló, sigue sin exportar
    expect(byId.get(oldUnexported)!.exported_to).toBeNull(); // fuera de ventana, ni se intenta
    expect(byId.get(alreadyExported)!.exported_to).toBe("odoo"); // no se toca
  });

  it("un error inesperado (throw) en un lead no detiene el resto del batch", async () => {
    const now = 1_000 * 24 * HOUR;
    await insertLead("lead-a", now - 1 * HOUR);
    await insertLead("lead-b", now - 1 * HOUR);

    vi.useFakeTimers();
    vi.setSystemTime(now);

    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("network down");
      return new Response(JSON.stringify({ ok: true, odoo_lead_id: 222 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as any);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(reconcileExportedLeads(env)).resolves.not.toThrow();

    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // exportLeadToOdoo ya atrapa el throw internamente (fail-soft), así que
    // el segundo lead de todos modos se intenta y se exporta.
    const all = await leads.list(10);
    const exportedCount = all.filter((l) => l.exported_to === "odoo").length;
    expect(exportedCount).toBe(1);
    void consoleErrorSpy;
  });
});
