import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { ADMIN_USERNAME } from "../../src/admin/auth";
import { renderCitas } from "../../src/admin/views/citas";
import { layout } from "../../src/admin/views/layout";

const PASSWORD = "secret123";
const auth = { Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${PASSWORD}`).toString("base64")}` };

let env: any;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = { DB: d1, DASHBOARD_PASSWORD: PASSWORD, BOT_TIER: "pro", BUSINESS_NAME: "T", BOT_LANGUAGE: "es", CALCOM_API_KEY: "cal_x" };
});
afterEach(() => vi.unstubAllGlobals());

const reserva = (over: Record<string, unknown> = {}) => ({
  uid: "u1", title: "Diagnóstico", start: "2026-11-17T16:00:00.000Z", end: "2026-11-17T16:50:00.000Z", status: "accepted",
  attendees: [{ name: "Ana <b>Pérez</b>", email: "ana@x.com" }], location: "https://teams.example/abc", ...over,
});
const stubCal = (data: unknown[]) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data, pagination: { hasMore: false, nextCursor: null } }), { status: 200 })));

describe("/admin/citas con la bandera apagada (por omisión)", () => {
  it("responde 404", async () => {
    const res = await adminApp.request("/citas", { headers: auth }, env);
    expect(res.status).toBe(404);
  });
  it("el menú no muestra Citas", () => {
    expect(layout({ title: "x", activeTab: "tickets", body: "", env })).not.toContain("/admin/citas");
    expect(layout({ title: "x", activeTab: "tickets", body: "" })).not.toContain("/admin/citas");
  });
  it("sigue pidiendo contraseña", async () => {
    expect((await adminApp.request("/citas", {}, env)).status).toBe(401);
  });
});

describe("/admin/citas con FEATURE_CITAS_PANEL=1", () => {
  beforeEach(() => { env.FEATURE_CITAS_PANEL = "1"; });

  it("muestra la cita, escapa el HTML del nombre y enlaza la reunión", async () => {
    stubCal([reserva()]);
    const html = await renderCitas(env, { rango: "30d" }, new Date("2026-11-16T15:00:00Z"));
    expect(html).toContain("Diagnóstico");
    expect(html).toContain("Ana &lt;b&gt;Pérez&lt;/b&gt;");
    expect(html).not.toContain("<b>Pérez</b>");
    expect(html).toContain('href="https://teams.example/abc"');
    expect(html).toContain("10:00"); // 16:00Z en Ciudad de México
    expect(html).toContain("/admin/citas"); // entrada de menú
  });

  it("no vuelve href una ubicación que no sea http(s)", async () => {
    stubCal([reserva({ location: "javascript:alert(1)" })]);
    const html = await renderCitas(env, { rango: "30d" }, new Date("2026-11-16T15:00:00Z"));
    expect(html).not.toContain("javascript:alert(1)\"");
  });

  it("filtra por estado y por búsqueda", async () => {
    stubCal([reserva(), reserva({ uid: "u2", status: "cancelled", attendees: [{ name: "Beto", email: "b@x.com" }] })]);
    const ahora = new Date("2026-11-16T15:00:00Z");
    const solo = await renderCitas(env, { rango: "30d", estado: "cancelada" }, ahora);
    expect(solo).toContain("Beto");
    expect(solo).not.toContain("Ana");
    stubCal([reserva(), reserva({ uid: "u2", attendees: [{ name: "Beto", email: "b@x.com" }] })]);
    const busca = await renderCitas(env, { rango: "30d", q: "beto" }, ahora);
    expect(busca).toContain("Beto");
    expect(busca).not.toContain("Ana");
  });

  it("dice que no hay citas cuando el rango está vacío", async () => {
    stubCal([]);
    expect(await renderCitas(env, {}, new Date("2026-11-16T15:00:00Z"))).toContain("No hay citas en este rango.");
  });

  it("si Cal.com falla muestra el aviso y no se cae", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const res = await adminApp.request("/citas", { headers: auth }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No se pudo leer Cal.com");
  });

  it("la ruta responde 200 con la bandera encendida", async () => {
    stubCal([]);
    expect((await adminApp.request("/citas?rango=hoy", { headers: auth }, env)).status).toBe(200);
  });
});
