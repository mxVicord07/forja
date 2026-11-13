/**
 * Seguimiento del CRM para el panel de Leads — SOLO LECTURA y en vivo.
 * Lo sirve el flujo de n8n `BRX_Forja_Seguimiento` (Arquitectura Digital BIRevX/copiloto/src/seguimiento-panel.js).
 * Odoo es el dueño del dato: Forja no guarda copia ni tiene «sincronizar»; cada
 * vez que se abre la pantalla se lee el estado del momento. Fail-soft: sin URL,
 * con n8n caído o lento devuelve { ok:false } y la pantalla de Leads sigue igual.
 */
import type { Env } from "../env";

export interface FilaSeguimiento {
  id: number;
  tipo: "oportunidad" | "prospecto";
  titulo: string;
  quien: string;
  etapa: string | null;
  monto: number;
  semaforo: string | null;
  codigo: string | null;
  siguienteToque: string | null;
  proximaCita: string | null;
  ultimoContacto: string | null;
  canal: string | null;
  actividad: { fecha: string; resumen: string | null } | null;
  conversacion: string | null;
  url: string | null;
  waPropio: string | null;
  /** `plantilla`: texto del semáforo (plantilla aprobada). `borrador`: texto para que el dueño lo edite y lo mande él desde su app. */
  sugerido: { tipo: "plantilla" | "borrador"; texto: string; waUrl: string | null; permitido: boolean; motivo: string | null } | null;
}

export interface Seguimiento {
  generado: string;
  resumen: { etapas: { etapa: string; cuenta: number; monto: number }[]; prospectos: number; oportunidades: number; tocarHoy: number; sinActividad: number; actividadVencida: number };
  filas: FilaSeguimiento[];
  aviso: string | null;
  /** Teléfonos (E.164) de los que se preguntó y que NO están en Odoo. null = no se pudo saber. */
  sinRegistro: string[] | null;
}

const TIMEOUT_MS = 6000;
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const http = (v: unknown): string | null => (typeof v === "string" && /^https:\/\//i.test(v) ? v : null);
/** Solo enlaces de WhatsApp: nada más puede salir en un botón «Abrir WhatsApp». */
const wa = (v: unknown): string | null => (typeof v === "string" && /^https:\/\/wa\.me\/\d{8,15}(\?text=[^\s"'<>]*)?$/.test(v) ? v : null);
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function normalizeSeguimiento(data: unknown): Seguimiento | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, any>;
  if (!d.ok || !Array.isArray(d.filas) || !d.resumen) return null;
  const filas: FilaSeguimiento[] = [];
  for (const raw of d.filas) {
    if (!raw || typeof raw !== "object" || !Number.isFinite(Number(raw.id))) continue;
    const s = raw.sugerido && typeof raw.sugerido === "object" && str(raw.sugerido.texto, 1200)
      ? { tipo: raw.sugerido.tipo === "borrador" ? ("borrador" as const) : ("plantilla" as const), texto: str(raw.sugerido.texto, 1200)!, waUrl: raw.sugerido.permitido === true ? wa(raw.sugerido.wa_url) : null, permitido: raw.sugerido.permitido === true, motivo: str(raw.sugerido.motivo, 160) }
      : null;
    filas.push({
      id: Number(raw.id),
      tipo: raw.tipo === "oportunidad" ? "oportunidad" : "prospecto",
      titulo: str(raw.titulo, 160) ?? "",
      quien: str(raw.quien, 100) ?? "",
      etapa: str(raw.etapa, 60),
      monto: num(raw.monto),
      semaforo: str(raw.semaforo, 200),
      codigo: str(raw.codigo, 60),
      siguienteToque: str(raw.siguiente_toque, 10),
      proximaCita: str(raw.proxima_cita, 30),
      ultimoContacto: str(raw.ultimo_contacto, 30),
      canal: str(raw.canal, 30),
      actividad: raw.actividad && str(raw.actividad.fecha, 10) ? { fecha: str(raw.actividad.fecha, 10)!, resumen: str(raw.actividad.resumen, 140) } : null,
      conversacion: str(raw.conversacion, 80),
      url: http(raw.url),
      waPropio: wa(raw.wa_propio),
      sugerido: s,
    });
  }
  const r = d.resumen;
  return {
    generado: str(d.generado, 40) ?? "",
    resumen: {
      etapas: Array.isArray(r.etapas) ? r.etapas.filter((e: any) => e && str(e.etapa)).map((e: any) => ({ etapa: str(e.etapa, 60)!, cuenta: num(e.cuenta), monto: num(e.monto) })) : [],
      prospectos: num(r.prospectos), oportunidades: num(r.oportunidades), tocarHoy: num(r.tocar_hoy), sinActividad: num(r.sin_actividad), actividadVencida: num(r.actividad_vencida),
    },
    filas,
    aviso: str(d.aviso, 200),
    sinRegistro: Array.isArray(d.sin_registro) ? d.sin_registro.filter((t: unknown): t is string => typeof t === "string" && /^\+\d{11,13}$/.test(t)) : null,
  };
}

export async function fetchSeguimiento(env: Env, telefonos: string[] = []): Promise<{ ok: true; data: Seguimiento } | { ok: false; reason: string }> {
  if (!env.CRM_SEGUIMIENTO_URL) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(env.CRM_SEGUIMIENTO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telefonos: telefonos.slice(0, 80) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = normalizeSeguimiento(await res.json());
    return data ? { ok: true, data } : { ok: false, reason: "respuesta_invalida" };
  } catch (e: any) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timeout" : "transient" };
  }
}
