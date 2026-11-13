import { describe, it, expect, vi, afterEach } from "vitest";
import { listContentTemplates, listYCloudTemplates, parseYcSid, templateVariables, sendTwilioTemplate, sendCampaign, campanasPorPlantillaBloqueadas } from "../src/campaigns";

afterEach(() => vi.unstubAllGlobals());
const env = (o: Record<string, unknown> = {}) => ({ WA_PROVIDER: "ycloud", YCLOUD_API_KEY: "k", YCLOUD_WA_FROM: "+5210000000000", ...o }) as any;
// Forma real de la API de YCloud (verificada el 12-nov-2026).
const respuesta = { offset: 0, limit: 100, length: 3, items: [
  { name: "cita_recordatorio_v1", language: "es_MX", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}}." }, { type: "BUTTONS" }] },
  { name: "en_revision_v1", language: "es_MX", status: "PENDING", category: "MARKETING", components: [{ type: "BODY", text: "x" }] },
  { name: "retomar_conversacion_v1", language: "es_MX", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hola {{1}}, quedó pendiente {{2}}. {{1}}" }] },
] };

describe("utilidades de plantillas de YCloud", () => {
  it("parseYcSid acepta solo el formato propio", () => {
    expect(parseYcSid("yc:cita_recordatorio_v1:es_MX")).toEqual({ name: "cita_recordatorio_v1", language: "es_MX" });
    for (const malo of ["HX123", "yc:Con Espacios:es", "yc:a:es_MX:extra", "yc::es"]) expect(parseYcSid(malo)).toBeNull();
  });
  it("templateVariables: en orden y sin repetir", () => {
    expect(templateVariables("Hola {{2}}, {{1}} y {{ 2 }}")).toEqual(["1", "2"]);
    expect(templateVariables("sin variables")).toEqual([]);
  });
});

describe("listYCloudTemplates", () => {
  it("devuelve solo las aprobadas, con cuerpo y variables", async () => {
    const f = vi.fn(async (_u: any, _i: any) => new Response(JSON.stringify(respuesta), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const t = await listContentTemplates(env());
    expect(t.map((x) => x.sid)).toEqual(["yc:cita_recordatorio_v1:es_MX", "yc:retomar_conversacion_v1:es_MX"]);
    expect(t[0].variables).toEqual(["1", "2", "3"]);
    expect(t[1].name).toContain("marketing");
    expect((f.mock.calls[0][1] as any).headers["X-API-Key"]).toBe("k");
    expect(String(f.mock.calls[0][0])).toContain("/v2/whatsapp/templates");
  });
  it("sin llave o con error devuelve lista vacía", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    expect(await listYCloudTemplates(env({ YCLOUD_API_KEY: undefined }))).toEqual([]);
    expect(f).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 401 })));
    expect(await listYCloudTemplates(env())).toEqual([]);
  });
});

describe("envío de una plantilla de YCloud por el mismo punto de entrada", () => {
  it("ordena las variables por número y usa el nombre y el idioma del sid", async () => {
    const f = vi.fn(async (_u: any, _i: any) => new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await sendTwilioTemplate(env(), "5214441112233", "yc:cita_recordatorio_v1:es_MX", { "2": "martes", "1": "Ana", "3": "10:00" });
    const body = JSON.parse((f.mock.calls[0][1] as any).body);
    expect(body.template.name).toBe("cita_recordatorio_v1");
    expect(body.template.language.code).toBe("es_MX");
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(["Ana", "martes", "10:00"]);
    expect(body.to).toBe("+5214441112233");
  });
  it("si YCloud rechaza, lanza (la campaña lo cuenta como fallido)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(sendTwilioTemplate(env(), "5214441112233", "yc:x_v1:es_MX", {})).rejects.toThrow(/YCloud rechazó/);
  });
});

describe("bloqueo de plantillas masivas con CRM", () => {
  it("un bot conectado al CRM no manda campañas por plantilla", async () => {
    expect(campanasPorPlantillaBloqueadas(env())).toBe(false);
    expect(campanasPorPlantillaBloqueadas(env({ CRM_SEGUIMIENTO_URL: "https://x" }))).toBe(true);
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    await expect(sendCampaign(env({ CRM_AGENDA_URL: "https://x", DB: {} }), { segmentId: "s", campaignKey: "k", template: { sid: "yc:x_v1:es_MX" } })).rejects.toThrow(/salen por el CRM/);
    expect(f).not.toHaveBeenCalled();
  });
});
