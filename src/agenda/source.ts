/**
 * Panel de citas — forma única de una cita y lógica pura (sin red ni base de
 * datos): normaliza una reserva de Cal.com, la une con la tabla propia
 * `appointments` y calcula rangos y filtros.
 *
 * Regla de fuentes (una sola por instalación): la lista sale de Cal.com. La
 * tabla propia NUNCA agrega filas a la lista; solo aporta el enlace a la
 * conversación, el teléfono y el aviso de «cambio pendiente». Si Cal.com no
 * está disponible, el panel usa la tabla propia entera (`fromLocalRow`).
 */
import type { Appointment } from "../db/appointments";

export type EstadoCita = "confirmada" | "por_confirmar" | "cambio_pendiente" | "cancelada";
export type OrigenCita = "lia" | "reserva" | "odoo";

export interface CitaPanel {
  uid: string;
  titulo: string;
  /** ISO en UTC. */
  inicio: string;
  duracionMin: number | null;
  estado: EstadoCita;
  /** `lia`: la agendó el asistente (hay fila propia); `reserva`: llegó por el enlace de reserva; `odoo`: calendario de Odoo (Outlook, Copiloto o Cal.com). */
  origen: OrigenCita;
  persona: { nombre: string; correo: string; telefono: string | null };
  lugar: string | null;
  enlace: string | null;
  /** id de conversación de Forja (p. ej. `whatsapp:521…`) o null. */
  conversacion: string | null;
  /** Oportunidad de Odoo ligada (solo con la fuente Odoo). */
  oportunidad?: { id: number; nombre: string; url: string } | null;
  /** Evento sin invitados externos: se muestra como «Ocupado», sin datos. */
  privado?: boolean;
}

const ESTADO_CAL: Record<string, EstadoCita> = {
  accepted: "confirmada",
  pending: "por_confirmar",
  awaiting_host: "por_confirmar",
  cancelled: "cancelada",
  rejected: "cancelada",
};

const esUrl = (s: string) => /^https?:\/\//i.test(s);

/** Reserva de Cal.com (`GET /v2/bookings`) → cita del panel. null si no sirve (sin uid o fecha inválida). */
export function normalizeCalBooking(raw: unknown): CitaPanel | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  if (typeof b.uid !== "string" || !b.uid) return null;
  const ini = new Date(String(b.start));
  if (Number.isNaN(ini.getTime())) return null;

  let duracion: number | null = typeof b.duration === "number" && b.duration > 0 ? b.duration : null;
  if (duracion == null && b.end) {
    const fin = new Date(String(b.end));
    if (!Number.isNaN(fin.getTime())) duracion = Math.round((fin.getTime() - ini.getTime()) / 60000);
  }

  const att = Array.isArray(b.attendees) && b.attendees[0] ? b.attendees[0] : {};
  const ubic = typeof b.location === "string" && b.location.trim() ? b.location.trim() : null;
  const enlace = ubic && esUrl(ubic) ? ubic : typeof b.meetingUrl === "string" && esUrl(b.meetingUrl) ? b.meetingUrl : null;

  return {
    uid: b.uid,
    titulo: typeof b.title === "string" ? b.title : "",
    inicio: String(b.start),
    duracionMin: duracion,
    estado: ESTADO_CAL[String(b.status)] ?? "por_confirmar",
    origen: "reserva",
    persona: {
      nombre: typeof att.name === "string" ? att.name : "",
      correo: typeof att.email === "string" ? att.email : "",
      telefono: null,
    },
    lugar: ubic && !esUrl(ubic) ? ubic : null,
    enlace,
    conversacion: null,
  };
}

const ESTADO_LOCAL: Record<Appointment["status"], EstadoCita> = {
  confirmed: "confirmada",
  change_pending: "cambio_pendiente",
  cancelled: "cancelada",
};

/** Fila de la tabla propia → cita del panel (respaldo cuando Cal.com no responde). */
export function fromLocalRow(a: Appointment): CitaPanel {
  return {
    uid: a.calcom_uid,
    titulo: "",
    inicio: a.start,
    duracionMin: null,
    estado: ESTADO_LOCAL[a.status] ?? "confirmada",
    origen: "lia",
    persona: { nombre: a.attendee_name, correo: a.attendee_email, telefono: a.attendee_phone },
    lugar: null,
    enlace: null,
    conversacion: a.conversation_id,
  };
}

/** Une la lista de Cal.com con la tabla propia por `uid`. No agrega filas de la tabla propia. */
export function mergeCitas(cal: CitaPanel[], locales: Appointment[]): CitaPanel[] {
  const porUid = new Map(locales.map((l) => [l.calcom_uid, l]));
  return cal
    .map((c) => {
      const l = porUid.get(c.uid);
      if (!l) return c;
      return {
        ...c,
        origen: "lia" as const,
        conversacion: l.conversation_id,
        persona: { ...c.persona, telefono: l.attendee_phone ?? c.persona.telefono },
        // Un cambio pendiente (el cliente pidió mover o cancelar) manda sobre «confirmada».
        estado: l.status === "change_pending" && c.estado !== "cancelada" ? ("cambio_pendiente" as const) : c.estado,
      };
    })
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
}

// ── Rangos ────────────────────────────────────────────────────────────────

export const RANGOS = ["proximas", "hoy", "7d", "30d", "pasadas"] as const;
export type ClaveRango = (typeof RANGOS)[number];

function offsetMs(utcMs: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(utcMs / 1000) * 1000;
}

/** Instante UTC (ms) en que empieza el día `ahora` en la zona dada. */
function inicioDelDia(ahora: Date, tz: string): number {
  const o = offsetMs(ahora.getTime(), tz);
  const local = new Date(ahora.getTime() + o);
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Segunda pasada: el offset de la medianoche puede diferir del de «ahora» (cambio de horario).
  return guess - offsetMs(guess - o, tz);
}

const DIA = 86_400_000;

export function rangoCitas(clave: string, ahora: Date, tz: string): { clave: ClaveRango; desde: string; hasta: string } {
  const k: ClaveRango = (RANGOS as readonly string[]).includes(clave) ? (clave as ClaveRango) : "proximas";
  const hoy = inicioDelDia(ahora, tz);
  const iso = (ms: number) => new Date(ms).toISOString();
  switch (k) {
    case "hoy": return { clave: k, desde: iso(hoy), hasta: iso(hoy + DIA) };
    case "7d": return { clave: k, desde: iso(hoy), hasta: iso(hoy + 7 * DIA) };
    case "30d": return { clave: k, desde: iso(hoy), hasta: iso(hoy + 30 * DIA) };
    case "pasadas": return { clave: k, desde: iso(hoy - 30 * DIA), hasta: ahora.toISOString() };
    default: return { clave: "proximas", desde: iso(hoy), hasta: iso(hoy + 14 * DIA) };
  }
}

// ── Filtros ───────────────────────────────────────────────────────────────

export function filtrarCitas(citas: CitaPanel[], f: { estado?: string; q?: string }): CitaPanel[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return citas.filter((c) => {
    if (f.estado && c.estado !== f.estado) return false;
    if (q && !`${c.persona.nombre} ${c.persona.correo} ${c.titulo}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
