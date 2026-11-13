import type { Env } from "./env";

export function getBufferMs(env: Env): number {
  return Math.max(1000, parseInt(env.BUFFER_SECONDS, 10) * 1000);
}

export function isPro(env: Env): boolean {
  return env.BOT_TIER === "pro";
}

// ── Niveles del producto (F3, 13-nov-2026) ───────────────────────────────────
// Tres niveles visibles: Starter → Negocio (★ recomendado) → Pro. SONIA (Odoo)
// es la línea de arriba, no un cuarto nivel. `BOT_TIER` acepta "starter" (o
// "free", su alias histórico), "negocio" y "pro". isPro() NO cambia: todo lo
// que hoy es Pro sigue siendo Pro; el Negocio solo gana lo que dice la tabla.
export type Nivel = "starter" | "negocio" | "pro";
const RANGO: Record<Nivel, number> = { starter: 0, negocio: 1, pro: 2 };

export function nivel(env: Pick<Env, "BOT_TIER">): Nivel {
  const t = String(env.BOT_TIER ?? "").trim().toLowerCase();
  return t === "pro" ? "pro" : t === "negocio" ? "negocio" : "starter";
}

/** Capacidad → nivel mínimo. Única fuente de verdad de qué trae cada paquete. */
export const CAPACIDADES = {
  agendaCompleta: "negocio", // varios tipos de cita; el Starter solo agenda básica con FEATURE_AGENDA
  reporteDiario: "negocio", // el Starter recibe el semanal
  catalogo: "pro",
  cobrosPorChat: "pro",
} as const satisfies Record<string, Nivel>;
export type Capacidad = keyof typeof CAPACIDADES;

export function tiene(env: Pick<Env, "BOT_TIER">, cap: Capacidad): boolean {
  return RANGO[nivel(env)] >= RANGO[CAPACIDADES[cap]];
}

/** Pestañas del panel con nivel mínimo. Las que no están aquí, las ve cualquier nivel. */
export const NIVEL_PESTANA: Record<string, Nivel> = {
  report: "negocio",
  plantillas: "negocio",
  insights: "pro",
  stats: "pro",
  costs: "pro",
  mejoras: "pro",
  campanas: "pro",
  reviews: "pro",
  boveda: "pro",
  cobros: "pro",
};

/** Nivel que pide la pestaña si este bot no lo alcanza; null si puede verla. */
export function pestanaBloqueada(env: Pick<Env, "BOT_TIER">, id: string): Nivel | null {
  const min = NIVEL_PESTANA[id];
  return min && RANGO[nivel(env)] < RANGO[min] ? min : null;
}

export const NOMBRE_NIVEL: Record<Nivel, string> = { starter: "Starter", negocio: "Negocio", pro: "Pro" };

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
export const PRO_ONLY_TABS = ["insights", "stats", "costs", "mejoras", "campanas", "plantillas", "reviews", "boveda", "cobros", "report"] as const; // histórico; el candado real es NIVEL_PESTANA

export function isToolAvailable(env: Env, toolName: string): boolean {
  if (!PRO_ONLY_TOOLS.includes(toolName as (typeof PRO_ONLY_TOOLS)[number])) return true;
  if (toolName === "scheduleAppointment") return agendaDisponible(env);
  if (toolName === "catalogQuery") return tiene(env, "catalogo");
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
  return tiene(env, "agendaCompleta") || env.FEATURE_AGENDA === "1";
}

/** Agenda básica del Starter: encendida por bandera en un bot que NO es Pro. */
export function agendaBasica(env: Env): boolean {
  return !tiene(env, "agendaCompleta") && env.FEATURE_AGENDA === "1";
}

/** ¿Está encendido el panel de citas (/admin/citas)? Apagado por omisión. */
export function citasPanelEnabled(env: Env): boolean {
  return env.FEATURE_CITAS_PANEL === "1";
}
