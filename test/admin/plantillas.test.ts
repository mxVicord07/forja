import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { plantillaDe } from "../../src/lib/plantillasRoles";

const AUTH = { Authorization: "Basic " + btoa("admin:pw") };
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };
let env: any;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  env = { DB: await mf.getD1Database("DB"), DASHBOARD_PASSWORD: "pw", BOT_TIER: "pro", BUSINESS_NAME: "T", BOT_LANGUAGE: "es", WA_PROVIDER: "ycloud", YCLOUD_API_KEY: "k", REENGAGE_PLANTILLA: "vieja_v1" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [
    { name: "retomar_conversacion_v1", language: "es_MX", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hola {{1}}, ¿retomamos lo de {{2}}?" }] },
    { name: "aviso_propuesta_aceptada_v1", language: "es_MX", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hola Víctor, {{1}} aceptó la propuesta {{2}} por {{3}}." }] },
    { name: "pago_enlace_v1", language: "es_MX", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hola {{1}}, la factura {{2}} por {{3}}." }] },
    { name: "cita_recordatorio_v1", language: "es_MX", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hola {{1}}, te esperamos el {{2}} a las {{3}}." }] },
  ] }), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("Plantillas", () => {
  it("lista las aprobadas y ofrece asignarlas solo a la función con el mismo número de variables", async () => {
    const html = await (await adminApp.request("/plantillas", { headers: AUTH }, env)).text();
    expect(html).toContain("retomar_conversacion_v1");
    expect(html).toContain("Usar para reactivar leads fríos");
    expect(html).toContain("Usar para recordatorio de cita");
    expect(html).toContain("vieja_v1"); // la de la variable de entorno se ve como asignada
    // Solo se sugiere donde el nombre corresponde; los avisos internos nunca.
    expect((html.match(/Usar para recordatorio de cita/g) ?? []).length).toBe(1);
    expect(html).toContain("Aviso interno para ti");
  });
  it("asignar en el panel gana sobre la variable; «Quitar» la apaga; valores raros se rechazan", async () => {
    expect((await plantillaDe(env, "reenganche"))?.origen).toBe("variable");
    await adminApp.request("/plantillas/asignar", { method: "POST", headers: FORM, body: new URLSearchParams({ rol: "reenganche", nombre: "retomar_conversacion_v1", idioma: "es_MX" }) }, env);
    expect(await plantillaDe(env, "reenganche")).toEqual({ name: "retomar_conversacion_v1", language: "es_MX", origen: "panel" });
    await adminApp.request("/plantillas/asignar", { method: "POST", headers: FORM, body: new URLSearchParams({ rol: "reenganche", nombre: "-" }) }, env);
    expect(await plantillaDe(env, "reenganche")).toBeNull();
    const r = await adminApp.request("/plantillas/asignar", { method: "POST", headers: FORM, body: new URLSearchParams({ rol: "otro", nombre: "x" }) }, env);
    expect(r.headers.get("Location")).toContain("err=");
  });
});

describe("Reseñas", () => {
  it("muestra promedio y comentarios de la encuesta", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES ('c1','whatsapp','521','Ana',?,?)").bind(now, now).run();
    await env.DB.prepare("INSERT INTO survey_sends (conversation_id, sent_at, score, responded_at) VALUES ('c1', ?, 2, ?)").bind(now, now).run();
    await env.DB.prepare("INSERT INTO survey_open_responses (conversation_id, response_text, created_at) VALUES ('c1', 'Tardaron <mucho>', ?)").bind(now).run();
    const html = await (await adminApp.request("/reviews", { headers: AUTH }, env)).text();
    expect(html).toContain("Reseñas");
    expect(html).toContain("Tardaron &lt;mucho&gt;");
    expect(html).toContain("baja");
  });
});
