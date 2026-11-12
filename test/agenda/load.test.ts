import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";
import { cargarCitas } from "../../src/agenda/load";

let env: any;
let repo: AppointmentsRepo;
const rango = { desde: "2026-11-16T06:00:00.000Z", hasta: "2026-11-30T06:00:00.000Z" };

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  repo = new AppointmentsRepo(new Db(d1 as any));
  env = { DB: d1, CALCOM_API_KEY: "cal_x" };
  await repo.create({
    conversationId: "whatsapp:521444", calcomUid: "uid-1", eventTypeId: 1,
    start: "2026-11-17T16:00:00Z", attendeeName: "Ana", attendeeEmail: "ana@x.com", attendeePhone: "+521444",
  });
});
afterEach(() => vi.unstubAllGlobals());

const cal = (data: unknown[]) =>
  vi.fn(async () => new Response(JSON.stringify({ data, pagination: { hasMore: false, nextCursor: null } }), { status: 200 }));

describe("cargarCitas", () => {
  it("usa Cal.com como lista y liga la conversación de la tabla propia", async () => {
    vi.stubGlobal("fetch", cal([
      { uid: "uid-1", start: "2026-11-17T16:00:00.000Z", end: "2026-11-17T16:50:00.000Z", status: "accepted", attendees: [{ name: "Ana", email: "ana@x.com" }] },
      { uid: "uid-2", start: "2026-11-18T16:00:00.000Z", end: "2026-11-18T16:50:00.000Z", status: "accepted", attendees: [{ name: "Beto", email: "b@x.com" }] },
    ]));
    const r = await cargarCitas(env, rango);
    expect(r.fuente).toBe("calcom");
    expect(r.aviso).toBeNull();
    expect(r.citas.map((c) => [c.uid, c.conversacion])).toEqual([["uid-1", "whatsapp:521444"], ["uid-2", null]]);
  });

  it("si Cal.com falla cae a la tabla propia y avisa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const r = await cargarCitas(env, rango);
    expect(r.fuente).toBe("local");
    expect(r.aviso).toContain("http_401");
    expect(r.citas.map((c) => c.uid)).toEqual(["uid-1"]);
  });

  it("sin llave de Cal.com usa la tabla propia sin llamar a la red", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await cargarCitas({ ...env, CALCOM_API_KEY: undefined }, rango);
    expect(r.fuente).toBe("local");
    expect(r.aviso).toContain("no está conectado");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("cargarCitas con Odoo", () => {
  it("con CRM_AGENDA_URL manda Odoo y no consulta Cal.com", async () => {
    const f = vi.fn(async (url: any) => {
      if (String(url).includes("forja-agenda")) {
        return new Response(JSON.stringify({ ok: true, citas: [{ uid: "odoo:1", titulo: "SASU", inicio: "2026-11-17T16:00:00Z", persona: { nombre: "Ana", correo: "ana@x.com" } }] }), { status: 200 });
      }
      throw new Error("no debía llamar a Cal.com");
    });
    vi.stubGlobal("fetch", f);
    const r = await cargarCitas({ ...env, CRM_AGENDA_URL: "https://n8n.x/webhook/forja-agenda-1" }, rango);
    expect(r.fuente).toBe("odoo");
    expect(r.citas[0].conversacion).toBe("whatsapp:521444"); // misma persona y minuto que la fila propia
  });

  it("si Odoo falla cae a Cal.com y lo dice", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) =>
      String(url).includes("forja-agenda")
        ? new Response("x", { status: 502 })
        : new Response(JSON.stringify({ data: [], pagination: { hasMore: false, nextCursor: null } }), { status: 200 })));
    const r = await cargarCitas({ ...env, CRM_AGENDA_URL: "https://n8n.x/webhook/forja-agenda-1" }, rango);
    expect(r.fuente).toBe("calcom");
    expect(r.aviso).toContain("calendario de Odoo");
  });
});
