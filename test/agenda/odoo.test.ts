import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeOdooCita, listOdooCitas, ligarConversaciones, odooAgendaConfigured } from "../../src/agenda/odoo";
import type { Appointment } from "../../src/db/appointments";

afterEach(() => vi.unstubAllGlobals());
const rango = { desde: "2026-11-09T06:00:00.000Z", hasta: "2026-11-16T06:00:00.000Z" };
const env = (over: Record<string, unknown> = {}) => ({ CRM_AGENDA_URL: "https://n8n.example/webhook/forja-agenda-x", ...over }) as any;

const cita = (over: Record<string, unknown> = {}) => ({
  uid: "odoo:151", titulo: "SASU // Reunión", inicio: "2026-11-11T15:00:00Z", duracionMin: 60, estado: "confirmada", origen: "odoo", privado: false,
  persona: { nombre: "Marcos", correo: "Marcos@sasu.mx", telefono: "+524441112233" }, lugar: null, enlace: "https://teams.example/x",
  oportunidad: { id: 92, nombre: "SASU", url: "https://odoo.birevx.com/web#id=92&model=crm.lead&view_type=form" }, ...over,
});

describe("normalizeOdooCita", () => {
  it("convierte la respuesta de n8n", () => {
    const c = normalizeOdooCita(cita())!;
    expect(c).toMatchObject({ uid: "odoo:151", origen: "odoo", estado: "confirmada", duracionMin: 60, privado: false });
    expect(c.oportunidad?.id).toBe(92);
  });
  it("descarta oportunidades sin URL http y enlaces que no lo sean", () => {
    const c = normalizeOdooCita(cita({ enlace: "javascript:x", oportunidad: { id: 1, nombre: "x", url: "javascript:x" } }))!;
    expect(c.enlace).toBeNull();
    expect(c.oportunidad).toBeNull();
  });
  it("descarta citas sin uid o con fecha inválida", () => {
    expect(normalizeOdooCita(cita({ uid: "" }))).toBeNull();
    expect(normalizeOdooCita(cita({ inicio: "nada" }))).toBeNull();
    expect(normalizeOdooCita("x")).toBeNull();
  });
});

describe("listOdooCitas", () => {
  it("manda el rango por POST y devuelve las citas", async () => {
    const f = vi.fn(async (_u: any, _i: any) => new Response(JSON.stringify({ ok: true, citas: [cita()] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r = await listOdooCitas(env(), rango);
    expect(r.ok && r.citas.length).toBe(1);
    const [, init] = f.mock.calls[0];
    expect((init as any).method).toBe("POST");
    expect(JSON.parse((init as any).body)).toEqual(rango);
  });
  it("sin URL no llama a la red", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await listOdooCitas(env({ CRM_AGENDA_URL: undefined }), rango)).toEqual({ ok: false, reason: "not_configured" });
    expect(odooAgendaConfigured(env({ CRM_AGENDA_URL: undefined }))).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it("una respuesta con ok:false, un 500 o un error de red no rompen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "odoo_error" }), { status: 200 })));
    expect(await listOdooCitas(env(), rango)).toEqual({ ok: false, reason: "odoo_error" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect(await listOdooCitas(env(), rango)).toEqual({ ok: false, reason: "http_500" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await listOdooCitas(env(), rango)).toEqual({ ok: false, reason: "transient" });
  });
});

describe("ligarConversaciones", () => {
  const local = (over: Partial<Appointment> = {}): Appointment => ({
    id: 1, conversation_id: "whatsapp:521444", calcom_uid: "cal-1", event_type_id: 1, start: "2026-11-11T15:00:00.000Z",
    status: "confirmed", attendee_name: "Marcos", attendee_email: "marcos@sasu.mx", attendee_phone: "+521444", created_at: 1, updated_at: 1, ...over,
  });
  it("liga por correo y minuto de inicio, sin importar mayúsculas", () => {
    const [c] = ligarConversaciones([normalizeOdooCita(cita())!], [local()]);
    expect(c.conversacion).toBe("whatsapp:521444");
  });
  it("no liga si cambia la hora o la cita propia está cancelada", () => {
    expect(ligarConversaciones([normalizeOdooCita(cita())!], [local({ start: "2026-11-11T16:00:00Z" })])[0].conversacion).toBeNull();
    expect(ligarConversaciones([normalizeOdooCita(cita())!], [local({ status: "cancelled" })])[0].conversacion).toBeNull();
  });
  it("un cambio pendiente se refleja y un evento privado no se toca", () => {
    expect(ligarConversaciones([normalizeOdooCita(cita())!], [local({ status: "change_pending" })])[0].estado).toBe("cambio_pendiente");
    const priv = normalizeOdooCita(cita({ privado: true, persona: { nombre: "", correo: "", telefono: null } }))!;
    expect(ligarConversaciones([priv], [local()])[0].conversacion).toBeNull();
  });
});
