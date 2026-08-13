import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { LeadsRepo } from "../../src/db/leads";
import { captureLeadTool } from "../../src/tools/captureLead";

let env: any;
let leads: LeadsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  leads = new LeadsRepo(db);
  // The leads table FKs conversation_id -> conversations(id), so we need a real
  // conversation row before the tool can attach a lead to it (same pattern as
  // the green handoffHuman/pauseBot tool tests).
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = { DB: d1, BOT_TIER: "pro" };
});

afterEach(() => vi.restoreAllMocks());

describe("captureLeadTool", () => {
  it("creates lead in D1 even without external service", async () => {
    const tool = captureLeadTool(env, () => convId);
    // AI SDK v6: tool.execute is optional + expects (input, options). Invoke with
    // 2 args and cast the result (same pattern as the repo's green tool tests).
    const result = (await tool.execute!(
      {
        name: "María",
        contact: "+5215512345",
        intent: "Corte + barba 5pm",
      },
      {} as any,
    )) as { leadId: string; message: string };
    expect(result.leadId).toBeTruthy();
    const list = await leads.list(10);
    expect(list).toHaveLength(1);
    expect(list[0].intent).toBe("Corte + barba 5pm");
  });

  it("no llama al webhook si LEAD_EXPORT_WEBHOOK_URL no está configurado", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = captureLeadTool(env, () => convId);
    await tool.execute!({ intent: "Cotización sitio web" }, {} as any);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exporta el lead a Odoo (vía n8n) cuando LEAD_EXPORT_WEBHOOK_URL está configurado", async () => {
    // { ok: true, odoo_lead_id: N } es la respuesta real del workflow
    // BIRevX_Forja_Lead_to_Odoo (nodo "Responder OK" en n8n).
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, odoo_lead_id: 4321 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = {
      ...env,
      LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo",
      BOT_NAME: "BIRevX Support Bot",
    };
    const tool = captureLeadTool(withExport, () => convId);
    const result = (await tool.execute!(
      { name: "María", contact: "+5215512345", intent: "Corte + barba 5pm", notes: "prefiere tarde" },
      {} as any,
    )) as { leadId: string; message: string };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://n8n.birevx.com/webhook/forja-lead-to-odoo");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      leadId: result.leadId,
      conversationId: convId,
      name: "María",
      contact: "+5215512345",
      intent: "Corte + barba 5pm",
      notes: "prefiere tarde",
      channel: "BIRevX Support Bot",
    });
  });

  it("registra el odoo_lead_id devuelto con setExported", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, odoo_lead_id: 4321 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId);

    const result = (await tool.execute!({ intent: "Diagnóstico inicial" }, {} as any)) as { leadId: string };

    const list = await leads.list(10);
    expect(list[0].id).toBe(result.leadId);
    expect(list[0].exported_to).toBe("odoo");
    expect(list[0].external_id).toBe("4321");
  });

  it("si la respuesta del webhook no es JSON válido, no truena y no marca como exportado", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId);

    const result = (await tool.execute!({ intent: "Diagnóstico inicial" }, {} as any)) as { leadId: string };

    const list = await leads.list(10);
    expect(list[0].id).toBe(result.leadId);
    expect(list[0].exported_to).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("si el webhook de export falla, el lead igual queda guardado y la tool no truena", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId);

    const result = (await tool.execute!(
      { intent: "Diagnóstico inicial" },
      {} as any,
    )) as { leadId: string; message: string };

    expect(result.leadId).toBeTruthy();
    expect(result.message).toBe("Lead capturado.");
    const list = await leads.list(10);
    expect(list).toHaveLength(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[captureLead] export a Odoo falló:",
      expect.any(Error),
    );
  });

  it("el fetch de export se espera (await) — un webhook lento SÍ agrega su latencia a la respuesta", async () => {
    // Documenta el comportamiento actual: el fetch va dentro de un `await`
    // en el try/catch, no es fire-and-forget. Si un webhook de n8n lento se
    // vuelve un problema real, la solución es no esperar el fetch — no
    // cambiar el manejo de errores. Se verifica con una promesa controlada a
    // mano (fake timers choca con el proxy D1 de Miniflare).
    let releaseFetch!: () => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = () => resolve(new Response("ok", { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId);

    let settled = false;
    const pending = Promise.resolve(tool.execute!({ intent: "Cotización" }, {} as any)).then((r) => {
      settled = true;
      return r;
    });
    // Deja correr la escritura real a D1 (I/O de Miniflare) hasta llegar al
    // fetch — con timers reales, no fake (fake timers cuelga el proxy D1).
    await new Promise((r) => setTimeout(r, 50));
    expect(releaseFetch).toBeDefined(); // ya llegó al fetch
    expect(settled).toBe(false); // sigue esperando al webhook lento

    releaseFetch();
    const result = (await pending) as { leadId: string };
    expect(settled).toBe(true);
    expect(result.leadId).toBeTruthy();
  });
});
