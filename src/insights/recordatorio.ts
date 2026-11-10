/**
 * Recordatorio pedido por el cliente (I-052).
 *
 * Cuando el cliente dice «escríbeme el 15» o «hablamos el lunes», el Analista lo
 * detecta al calificar la conversación y el resumen viaja a n8n con
 * `recordatorio: { fecha, motivo }`; allá se crea la actividad en Odoo y se
 * avisa a Víctor. Aquí vive la parte pura: la fecha de hoy que ve el modelo y la
 * validación de lo que devuelve. Una fecha dudosa se descarta: es mejor no crear
 * una actividad que crear una con fecha equivocada.
 */

export const TZ_NEGOCIO = "America/Mexico_City";
/** Más allá de esto se considera un error de fecha del modelo, no un recordatorio. */
export const RECORDATORIO_MAX_DIAS = 180;

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export interface Recordatorio {
  /** AAAA-MM-DD, hoy o futura. */
  fecha: string;
  /** Qué pidió el cliente, en pocas palabras. */
  motivo: string;
}

/** AAAA-MM-DD de un instante en la zona del negocio. */
export function diaLocal(ms: number, tz = TZ_NEGOCIO): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
}

/** «lunes 2026-11-09»: lo que se le da al modelo para resolver «el lunes» o «el 15». */
export function hoyParaPrompt(ms: number, tz = TZ_NEGOCIO): string {
  const dia = diaLocal(ms, tz);
  const d = new Date(`${dia}T12:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${dia}`;
}

const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Lo que devolvió el modelo → un recordatorio válido o null. */
export function normalizarRecordatorio(raw: unknown, ahoraMs: number, tz = TZ_NEGOCIO): Recordatorio | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { date?: unknown; reason?: unknown };
  const fecha = typeof r.date === "string" ? r.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const t = Date.parse(`${fecha}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== fecha) return null; // 2026-02-31 no existe
  const hoy = diaLocal(ahoraMs, tz);
  const faltan = dias(hoy, fecha);
  if (faltan < 0 || faltan > RECORDATORIO_MAX_DIAS) return null;
  const motivo = (typeof r.reason === "string" ? r.reason : "").replace(/\s+/g, " ").trim().slice(0, 200);
  return { fecha, motivo: motivo || "retomar la conversación" };
}
