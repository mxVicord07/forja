/**
 * Chat y formulario web de producción (sitio birevx.com, 30-oct-2026). Hermano
 * del Modo Demo (src/demo.ts) pero pensado para un sitio público real:
 * apagado sin WEB_CHAT_ORIGINS, solo responde a esos orígenes, exige el aviso
 * de privacidad aceptado y pone topes de costo por sesión, por día y por IP.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

const notifyOwnerMock = vi.fn();
vi.mock("../src/tools/handoffHuman", async (orig) => ({
  ...(await orig<typeof import("../src/tools/handoffHuman")>()),
  notifyOwner: (...a: unknown[]) => notifyOwnerMock(...a),
}));

import worker from "../src/index";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { allowedOrigin, validateWebLead, handleWebLead } from "../src/webchat";

const ORIGIN = "https://www.birevx.com";

let d1: any;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  notifyOwnerMock.mockReset().mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

const envBase = (extra: Record<string, unknown> = {}) =>
  ({
    DB: d1,
    BOT_NAME: "LIA",
    WEB_CHAT_ORIGINS: "https://www.birevx.com, https://birevx.com",
    LEAD_EXPORT_WEBHOOK_URL: "https://n8n.example/upsert",
    AGENT: { idFromName: () => "id", get: () => ({ ingest: vi.fn().mockResolvedValue({ acknowledged: true }) }) },
    ...extra,
  }) as any;

const leadOk = {
  name: "Hugo Loredo",
  email: "Hugo@Clinica.mx",
  whatsapp: "444 123 4567",
  company: "Clínica Do Corpo · fisioterapia",
  budget: 60000,
  message: "Quiero que mis pacientes agenden solos y recordarles su cita.",
  consent: true,
  lang: "es",
  source: "contacto",
};

describe("allowedOrigin", () => {
  it("solo acepta los orígenes configurados, exactos", () => {
    const env = envBase();
    expect(allowedOrigin(env, "https://www.birevx.com")).toBe("https://www.birevx.com");
    expect(allowedOrigin(env, "https://birevx.com")).toBe("https://birevx.com");
    expect(allowedOrigin(env, "https://evil.com")).toBeNull();
    expect(allowedOrigin(env, "https://www.birevx.com.evil.com")).toBeNull();
    expect(allowedOrigin(envBase({ WEB_CHAT_ORIGINS: undefined }), ORIGIN)).toBeNull();
  });
});

describe("validateWebLead", () => {
  it("normaliza un lead válido", () => {
    const r = validateWebLead(leadOk);
    expect(r).toMatchObject({ ok: true, lead: { email: "hugo@clinica.mx", whatsapp: "4441234567", budget: 60000 } });
  });

  it("exige aviso de privacidad, correo y WhatsApp de 10 dígitos", () => {
    expect(validateWebLead({ ...leadOk, consent: false })).toMatchObject({ ok: false, error: "consent" });
    expect(validateWebLead({ ...leadOk, email: "no-es-correo" })).toMatchObject({ ok: false, error: "email" });
    expect(validateWebLead({ ...leadOk, whatsapp: "12345" })).toMatchObject({ ok: false, error: "whatsapp" });
    expect(validateWebLead({ ...leadOk, name: " " })).toMatchObject({ ok: false, error: "name" });
  });

  it("acota el presupuesto y marca como spam el campo trampa", () => {
    expect(validateWebLead({ ...leadOk, budget: -5 })).toMatchObject({ ok: true, lead: { budget: 0 } });
    expect(validateWebLead({ ...leadOk, budget: 9_999_999 })).toMatchObject({ ok: true, lead: { budget: 300000 } });
    expect(validateWebLead({ ...leadOk, website: "http://spam" })).toMatchObject({ ok: false, error: "spam" });
  });
});

describe("handleWebLead", () => {
  it("guarda el lead, lo manda a Odoo por el Upsert con canal web y avisa a Victor", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, odoo_lead_id: 140 })));
    const r = await handleWebLead(envBase(), validateWebLead(leadOk) as any, "1.2.3.4");
    expect(r).toEqual({ ok: true });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ channel: "web", name: "Hugo Loredo", email: "hugo@clinica.mx", phone: "4441234567" });
    expect(body.notes).toContain("60,000");
    expect(body.notes).toContain("Clínica Do Corpo");
    const row = await d1.prepare("SELECT exported_to, metadata FROM leads").first();
    expect(row.exported_to).toBe("odoo");
    expect(JSON.parse(row.metadata).channel).toBe("web");
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("si n8n falla, el lead queda en D1 para la reconciliación y la respuesta sigue siendo ok", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("caído"));
    expect(await handleWebLead(envBase(), validateWebLead(leadOk) as any, "1.2.3.4")).toEqual({ ok: true });
    const row = await d1.prepare("SELECT exported_to FROM leads").first();
    expect(row.exported_to).toBeNull();
  });

  it("limita a 5 envíos por hora por IP", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, odoo_lead_id: 1 })));
    const env = envBase();
    const lead = validateWebLead(leadOk) as any;
    for (let i = 0; i < 5; i++) expect(await handleWebLead(env, lead, "9.9.9.9")).toEqual({ ok: true });
    expect(await handleWebLead(env, lead, "9.9.9.9")).toEqual({ ok: false, error: "rate" });
    expect(await handleWebLead(env, lead, "8.8.8.8")).toEqual({ ok: true });
  });
});

const req = (path: string, init: RequestInit & { origin?: string } = {}) =>
  worker.fetch(
    new Request(`https://bot.test${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.origin ? { Origin: init.origin } : {}), ...(init.headers as any) },
    }),
    envBase(),
    { waitUntil: () => {} } as any,
  );

describe("rutas /web/*", () => {
  it("responde el preflight CORS solo al origen permitido", async () => {
    const ok = await req("/web/lead", { method: "OPTIONS", origin: ORIGIN });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const no = await req("/web/lead", { method: "OPTIONS", origin: "https://evil.com" });
    expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rechaza un POST desde un origen no permitido", async () => {
    const res = await req("/web/lead", { method: "POST", origin: "https://evil.com", body: JSON.stringify(leadOk) });
    expect(res.status).toBe(403);
  });

  it("apagado sin WEB_CHAT_ORIGINS", async () => {
    const res = await worker.fetch(
      new Request("https://bot.test/web/chat/poll?session=s1", { headers: { Origin: ORIGIN } }),
      envBase({ WEB_CHAT_ORIGINS: undefined }),
      {} as any,
    );
    expect(res.status).toBe(404);
  });

  it("el chat exige el aviso de privacidad aceptado", async () => {
    const res = await req("/web/chat/send", { method: "POST", origin: ORIGIN, body: JSON.stringify({ sessionId: "s1", text: "hola" }) });
    expect(res.status).toBe(400);
  });

  it("el chat con aviso aceptado entra al agente por el canal web", async () => {
    const res = await req("/web/chat/send", {
      method: "POST", origin: ORIGIN, body: JSON.stringify({ sessionId: "s1", text: "hola", consent: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});
