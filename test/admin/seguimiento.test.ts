import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { normalizeSeguimiento, fetchSeguimiento } from "../../src/crm/seguimiento";
import { renderSeguimientoBlock } from "../../src/admin/views/seguimiento";
import { renderLeads } from "../../src/admin/views/leads";

afterEach(() => vi.unstubAllGlobals());
const respuesta = (over: Record<string, unknown> = {}) => ({
  ok: true, generado: "2026-11-12T15:00:00Z",
  resumen: { etapas: [{ etapa: "Por firmar", cuenta: 2, monto: 62180 }], prospectos: 19, oportunidades: 2, tocar_hoy: 2, sin_actividad: 1, actividad_vencida: 1 },
  filas: [
    { id: 92, tipo: "oportunidad", titulo: "SASU <b>web</b>", quien: "Marcos", etapa: "Por firmar", monto: 60500, semaforo: "Tocar: propuesta", ultimo_contacto: "2026-11-11T15:00:00Z",
      actividad: { fecha: "2026-11-01", resumen: "Llamar" }, conversacion: "whatsapp:521444", url: "https://odoo.birevx.com/web#id=92&model=crm.lead&view_type=form",
      wa_propio: "https://wa.me/524441112233", sugerido: { texto: "Hola Marcos, ¿pudiste revisarla?", wa_url: "https://wa.me/524441112233?text=Hola%20Marcos", permitido: true } },
    { id: 133, tipo: "oportunidad", titulo: "Rente Firme", quien: "Jocelyn", etapa: "Por firmar", monto: 1680, actividad: null,
      sugerido: { texto: "Hola Jocelyn", wa_url: "https://wa.me/5215550000000?text=x", permitido: false, motivo: "Sin consentimiento vigente" } },
    { id: 128, tipo: "prospecto", titulo: "Saul", quien: "Saul", wa_propio: "javascript:alert(1)", url: "http://inseguro" },
  ],
  ...over,
});
const stub = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
const env = (over: Record<string, unknown> = {}) => ({ CRM_SEGUIMIENTO_URL: "https://n8n.x/webhook/forja-seguimiento-1", BOT_TIER: "pro", BUSINESS_NAME: "T", BOT_LANGUAGE: "es", ...over }) as any;

describe("normalizeSeguimiento", () => {
  it("valida enlaces: solo wa.me y https; sin permiso no hay enlace de envío", () => {
    const d = normalizeSeguimiento(respuesta())!;
    expect(d.filas[0].waPropio).toBe("https://wa.me/524441112233");
    expect(d.filas[0].sugerido?.waUrl).toContain("wa.me/524441112233?text=");
    expect(d.filas[1].sugerido).toMatchObject({ permitido: false, waUrl: null, motivo: "Sin consentimiento vigente" });
    expect(d.filas[2].waPropio).toBeNull();
    expect(d.filas[2].url).toBeNull();
    expect(d.resumen.tocarHoy).toBe(2);
  });
  it("rechaza respuestas sin ok o sin filas", () => {
    expect(normalizeSeguimiento({ ok: false })).toBeNull();
    expect(normalizeSeguimiento(null)).toBeNull();
  });
});

describe("fetchSeguimiento", () => {
  it("sin URL no llama a la red; con error devuelve el motivo", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    expect(await fetchSeguimiento(env({ CRM_SEGUIMIENTO_URL: undefined }))).toEqual({ ok: false, reason: "not_configured" });
    expect(f).not.toHaveBeenCalled();
    stub({}, 502);
    expect(await fetchSeguimiento(env())).toEqual({ ok: false, reason: "http_502" });
  });
});

describe("renderSeguimientoBlock", () => {
  const ahora = new Date("2026-11-12T15:00:00Z");
  it("no muestra nada si el bot no está conectado al CRM", async () => {
    expect(await renderSeguimientoBlock(env({ CRM_SEGUIMIENTO_URL: undefined }))).toBe("");
  });
  it("muestra etapas, alertas, el mensaje sugerido y el bloqueo por consentimiento, todo escapado", async () => {
    stub(respuesta());
    const html = await renderSeguimientoBlock(env(), ahora);
    expect(html).toContain("Por firmar");
    expect(html).toContain("2 · $62,180");
    expect(html).toContain("Enviar desde mi WhatsApp");
    expect(html).toContain("Sin consentimiento vigente");
    expect(html).toContain("Sin siguiente paso");
    expect(html).toContain("SASU &lt;b&gt;web&lt;/b&gt;");
    expect(html).not.toContain("<b>web</b>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("wa.me/5215550000000"); // sin permiso no hay enlace
    expect(html).toContain("Prospectos por calificar (1)");
  });
  it("si n8n falla lo dice y no rompe", async () => {
    stub({}, 500);
    expect(await renderSeguimientoBlock(env(), ahora)).toContain("No se pudo leer el seguimiento de Odoo");
  });
});

describe("renderLeads con y sin CRM", () => {
  let e: any;
  beforeEach(async () => {
    const mf = await createTestMiniflare();
    e = { DB: await mf.getD1Database("DB"), BOT_TIER: "pro", BUSINESS_NAME: "T", BOT_LANGUAGE: "es" };
  });
  it("sin CRM la pantalla queda como siempre", async () => {
    const html = await renderLeads(e);
    expect(html).not.toContain("Seguimiento en Odoo");
    expect(html).toContain("Exportar CSV");
  });
  it("con CRM agrega el bloque arriba y renombra la tabla local", async () => {
    stub(respuesta());
    const html = await renderLeads({ ...e, CRM_SEGUIMIENTO_URL: "https://n8n.x/webhook/forja-seguimiento-1" });
    expect(html.indexOf("Seguimiento en Odoo")).toBeLessThan(html.indexOf("Capturados por el asistente"));
  });
});
