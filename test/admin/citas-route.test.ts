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
    expect(html).not.toContain('href="javascript');
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

describe("/admin/citas en calendario (semana y mes)", () => {
  beforeEach(() => { env.FEATURE_CITAS_PANEL = "1"; });
  const jueves = new Date("2026-11-12T15:00:00Z"); // jueves 12-nov, 09:00 en Ciudad de México

  it("semana: pone la cita en su día, escapa el nombre y marca hoy", async () => {
    stubCal([reserva({ uid: "s1", start: "2026-11-13T16:00:00.000Z", attendees: [{ name: "<i>Ana</i>", email: "a@x.com" }] })]);
    const html = await renderCitas(env, { vista: "semana" }, jueves);
    expect(html).toContain("9 de noviembre al 15 de noviembre de 2026");
    expect(html).toContain("&lt;i&gt;Ana&lt;/i&gt;");
    expect(html).not.toContain("<i>Ana</i>");
    expect(html).toContain("10:00");
    expect(html).toContain("Lun");
    expect(html).toContain("Dom");
  });

  it("semana: Cal.com recibe el rango de lunes a lunes en UTC", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [], pagination: { hasMore: false, nextCursor: null } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await renderCitas(env, { vista: "semana" }, jueves);
    const url = String((f.mock.calls[0] as any[])[0]);
    expect(url).toContain("afterStart=2026-11-09T06%3A00%3A00.000Z");
    expect(url).toContain("beforeEnd=2026-11-16T06%3A00%3A00.000Z");
  });

  it("mes: muestra hasta 3 por día y «+N más»", async () => {
    stubCal([1, 2, 3, 4, 5].map((n) => reserva({ uid: `m${n}`, start: `2026-11-18T${String(15 + n).padStart(2, "0")}:00:00.000Z`, attendees: [{ name: `P${n}`, email: `p${n}@x.com` }] })));
    const html = await renderCitas(env, { vista: "mes" }, jueves);
    expect(html).toContain("Noviembre de 2026");
    expect(html).toContain("+2 más");
    expect(html).toContain("P1");
    expect(html).not.toContain(">P5<");
  });

  it("navegación: anterior y siguiente conservan vista, estado y búsqueda", async () => {
    stubCal([]);
    const html = await renderCitas(env, { vista: "mes", estado: "confirmada", q: "ana" }, jueves);
    expect(html).toContain("vista=mes");
    expect(html).toContain("ref=2026-12-01");
    expect(html).toContain("ref=2026-10-01");
    expect(html).toContain("estado=confirmada");
    expect(html).toContain("q=ana");
  });

  it("una referencia inválida cae en hoy y no rompe la página", async () => {
    stubCal([]);
    const html = await renderCitas(env, { vista: "semana", ref: "2026-13-45<script>" }, jueves);
    expect(html).toContain("9 de noviembre al 15 de noviembre de 2026");
    expect(html).not.toContain("2026-13-45");
  });

  it("las pestañas Lista, Semana y Mes están siempre", async () => {
    stubCal([]);
    const html = await renderCitas(env, {}, jueves);
    expect(html).toContain("vista=semana");
    expect(html).toContain("vista=mes");
    expect(html).toContain("Lista");
  });

  it("una cita con conversación enlaza a la conversación en el calendario", async () => {
    const { AppointmentsRepo } = await import("../../src/db/appointments");
    const { Db } = await import("../../src/db/client");
    await new AppointmentsRepo(new Db(env.DB)).create({
      conversationId: "whatsapp:521444", calcomUid: "u1", eventTypeId: 1,
      start: "2026-11-13T16:00:00Z", attendeeName: "Ana", attendeeEmail: "ana@x.com",
    });
    stubCal([reserva({ uid: "u1", start: "2026-11-13T16:00:00.000Z" })]);
    const html = await renderCitas(env, { vista: "semana" }, jueves);
    expect(html).toContain("/admin/conversations?c=whatsapp%3A521444");
  });
});

describe("/admin/citas con la fuente Odoo", () => {
  beforeEach(() => { env.FEATURE_CITAS_PANEL = "1"; env.CRM_AGENDA_URL = "https://n8n.x/webhook/forja-agenda-1"; });
  const jueves = new Date("2026-11-12T15:00:00Z");
  const stubOdoo = (citas: unknown[]) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, citas }), { status: 200 })));

  it("muestra la oportunidad, la fuente y cómo mover", async () => {
    stubOdoo([{ uid: "odoo:151", titulo: "SASU // Reunión", inicio: "2026-11-13T15:00:00Z", duracionMin: 60,
      persona: { nombre: "Marcos", correo: "m@sasu.mx" }, oportunidad: { id: 92, nombre: "SASU", url: "https://odoo.birevx.com/web#id=92&model=crm.lead&view_type=form" } }]);
    const html = await renderCitas(env, { rango: "30d" }, jueves);
    expect(html).toContain("Oportunidad: SASU");
    expect(html).toContain("Fuente: calendario de Odoo");
    expect(html).toContain("/agenda");
    expect(html).toContain("Calendario");
  });

  it("un evento privado sale como «Ocupado» sin datos", async () => {
    stubOdoo([{ uid: "odoo:9", titulo: "Ocupado", inicio: "2026-11-13T15:00:00Z", privado: true, persona: { nombre: "", correo: "" } }]);
    const lista = await renderCitas(env, { rango: "30d" }, jueves);
    expect(lista).toContain("Ocupado");
    const semana = await renderCitas(env, { vista: "semana" }, jueves);
    expect(semana).toContain("Ocupado");
  });

  it("el título del calendario solo lleva mayúscula inicial", async () => {
    stubOdoo([]);
    const html = await renderCitas(env, { vista: "mes" }, jueves);
    expect(html).toContain(">Noviembre de 2026<");
    expect(html).not.toContain("text-transform:capitalize");
  });
});

describe("/admin/citas con Cal.com: avisos y canceladas", () => {
  beforeEach(() => { env.FEATURE_CITAS_PANEL = "1"; });
  it("dice que faltan las reuniones de Outlook si Odoo no está conectado", async () => {
    stubCal([]);
    expect(await renderCitas(env, {}, new Date("2026-11-12T15:00:00Z"))).toContain("no aparecen hasta conectar Odoo");
  });
  it("una cita cancelada no muestra el enlace a la reunión", async () => {
    stubCal([reserva({ status: "cancelled" })]);
    const html = await renderCitas(env, { rango: "30d" }, new Date("2026-11-16T15:00:00Z"));
    expect(html).not.toContain('href="https://teams.example/abc"');
  });
});

describe("nombreVisible", () => {
  it("usa el título cuando el nombre del contacto es un correo", async () => {
    const { nombreVisible } = await import("../../src/admin/views/citas");
    const base = { uid: "u", inicio: "2026-11-10T18:00:00Z", duracionMin: 60, estado: "confirmada", origen: "odoo", lugar: null, enlace: null, conversacion: null } as any;
    expect(nombreVisible({ ...base, titulo: "Ex-Change // Dr. Eduardo", persona: { nombre: "hospitalcmv@hotmail.com", correo: "hospitalcmv@hotmail.com", telefono: null } })).toBe("Ex-Change // Dr. Eduardo");
    expect(nombreVisible({ ...base, titulo: "SASU", persona: { nombre: "Elena Sánchez", correo: "e@x.mx", telefono: null } })).toBe("Elena Sánchez");
    expect(nombreVisible({ ...base, titulo: "", persona: { nombre: "", correo: "z@x.mx", telefono: null } })).toBe("z@x.mx");
  });
});
