/**
 * Panel de citas — fuente Odoo, servida por el flujo de n8n `BRX_Forja_Agenda`
 * (SOLO LECTURA; código en Arquitectura Digital BIRevX/copiloto/src/agenda-panel.js).
 * El calendario de Odoo junta lo creado en Outlook, lo que agenda el Copiloto y
 * lo que llega de Cal.com por Outlook (verificado el 12-nov-2026).
 *
 * Fail-soft como crmFicha.ts: sin URL, con n8n caído, lento o con una respuesta
 * rara devuelve { ok:false } y el panel cae a Cal.com.
 */
import type { Env } from "../env";
import type { Appointment } from "../db/appointments";
import type { CitaPanel } from "./source";

const TIMEOUT_MS = 4000;
const esUrl = (s: unknown): s is string => typeof s === "string" && /^https?:\/\//i.test(s);

export function odooAgendaConfigured(env: Env): boolean {
  return Boolean(env.CRM_AGENDA_URL);
}

/** Una cita de la respuesta de n8n → CitaPanel. null si no trae lo mínimo. */
export function normalizeOdooCita(raw: unknown): CitaPanel | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, any>;
  if (typeof c.uid !== "string" || !c.uid) return null;
  if (Number.isNaN(new Date(String(c.inicio)).getTime())) return null;
  const p = c.persona && typeof c.persona === "object" ? c.persona : {};
  const o = c.oportunidad && typeof c.oportunidad === "object" && Number.isFinite(Number(c.oportunidad.id)) && esUrl(c.oportunidad.url)
    ? { id: Number(c.oportunidad.id), nombre: String(c.oportunidad.nombre ?? ""), url: String(c.oportunidad.url) }
    : null;
  return {
    uid: c.uid,
    titulo: typeof c.titulo === "string" ? c.titulo : "",
    inicio: String(c.inicio),
    duracionMin: typeof c.duracionMin === "number" && c.duracionMin > 0 ? c.duracionMin : null,
    estado: "confirmada",
    origen: "odoo",
    persona: {
      nombre: typeof p.nombre === "string" ? p.nombre : "",
      correo: typeof p.correo === "string" ? p.correo : "",
      telefono: typeof p.telefono === "string" && p.telefono ? p.telefono : null,
    },
    lugar: typeof c.lugar === "string" && c.lugar ? c.lugar : null,
    enlace: esUrl(c.enlace) ? c.enlace : null,
    conversacion: null,
    oportunidad: o,
    privado: c.privado === true,
  };
}

export async function listOdooCitas(
  env: Env,
  rango: { desde: string; hasta: string },
): Promise<{ ok: true; citas: CitaPanel[] } | { ok: false; reason: string }> {
  if (!env.CRM_AGENDA_URL) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(env.CRM_AGENDA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desde: rango.desde, hasta: rango.hasta }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = (await res.json()) as { ok?: boolean; error?: string; citas?: unknown[] };
    if (!data?.ok || !Array.isArray(data.citas)) return { ok: false, reason: data?.error ? String(data.error).slice(0, 40) : "respuesta_invalida" };
    return { ok: true, citas: data.citas.map(normalizeOdooCita).filter((x): x is CitaPanel => x !== null) };
  } catch (e: any) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timeout" : "transient" };
  }
}

/**
 * Liga cada cita de Odoo con la conversación de Forja cuando el asistente la
 * agendó: mismo correo del invitado y mismo minuto de inicio (Cal.com → Outlook
 * → Odoo cambia el identificador, así que no hay uid común).
 */
export function ligarConversaciones(citas: CitaPanel[], locales: Appointment[]): CitaPanel[] {
  const minuto = (iso: string) => new Date(iso).toISOString().slice(0, 16);
  const clave = (correo: string, iso: string) => `${correo.trim().toLowerCase()}|${minuto(iso)}`;
  const porClave = new Map(locales.filter((l) => l.status !== "cancelled").map((l) => [clave(l.attendee_email, l.start), l]));
  return citas
    .map((c) => {
      if (c.privado || !c.persona.correo) return c;
      const l = porClave.get(clave(c.persona.correo, c.inicio));
      if (!l) return c;
      return {
        ...c,
        conversacion: l.conversation_id,
        persona: { ...c.persona, telefono: c.persona.telefono ?? l.attendee_phone },
        estado: l.status === "change_pending" ? ("cambio_pendiente" as const) : c.estado,
      };
    })
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
}
