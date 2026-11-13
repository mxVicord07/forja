import type { Env } from "./env";

export function getBufferMs(env: Env): number {
  return Math.max(1000, parseInt(env.BUFFER_SECONDS, 10) * 1000);
}

export function isPro(env: Env): boolean {
  return env.BOT_TIER === "pro";
}

// Tools reservadas al tier Pro. captureLead NO está aquí a propósito: el bot
// Starter (free) captura leads — es su valor central. Lo Pro son las tools más
// avanzadas por nicho (agendar citas, consultar catálogo/inventario).
export const PRO_ONLY_TOOLS = [
  "scheduleAppointment",
  "catalogQuery",
] as const;

// Tabs del dashboard reservadas al tier Pro (Análisis + growth). El tier free
// ve un panel funcional (Resumen, Conversaciones, Leads, Tickets, Flujo, KB,
// Conexiones, Config) pero sin el Analista IA, métricas, costos, mejoras ni
// campañas — esos desbloquean con la comunidad.
export const PRO_ONLY_TABS = ["insights", "stats", "costs", "mejoras", "campanas", "plantillas", "reviews", "boveda", "cobros", "report"] as const;

export function isToolAvailable(env: Env, toolName: string): boolean {
  if (!PRO_ONLY_TOOLS.includes(toolName as (typeof PRO_ONLY_TOOLS)[number])) return true;
  if (toolName === "scheduleAppointment") return agendaDisponible(env);
  return isPro(env);
}

/**
 * Agenda del asistente (consultar, agendar, mover y cancelar con Cal.com).
 * Pro la trae siempre. Un bot no Pro (Starter) la recibe con FEATURE_AGENDA="1"
 * como «agenda básica»: una sola cuenta de Cal.com y UN solo tipo de cita
 * (ver resolveEventTypeId), sin abrir ninguna pestaña ni herramienta Pro.
 * Decisión de Víctor, 12-nov-2026 (mapa §3.3).
 */
export function agendaDisponible(env: Env): boolean {
  return isPro(env) || env.FEATURE_AGENDA === "1";
}

/** Agenda básica del Starter: encendida por bandera en un bot que NO es Pro. */
export function agendaBasica(env: Env): boolean {
  return !isPro(env) && env.FEATURE_AGENDA === "1";
}

/** ¿Está encendido el panel de citas (/admin/citas)? Apagado por omisión. */
export function citasPanelEnabled(env: Env): boolean {
  return env.FEATURE_CITAS_PANEL === "1";
}
