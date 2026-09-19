/**
 * Mutaciones de settings compartidas — UNA sola tabla de validadores y UNA sola
 * definición de los superpoderes, para que el control plane (POST /api/settings,
 * si algún día se agrega) y el Centro de Mantenimiento de Forja Inbox
 * (GET/PATCH /api/maintenance) no puedan desincronizarse.
 *
 * Porteo del paquete Forja+ v1.0.76, RECORTADO a lo que este fork realmente
 * tiene — no es una copia 1:1. Excluido a propósito (no existe en este bot,
 * agregarlo aquí habría escrito settings que nadie lee):
 *   - brandStyle / admin/branding.ts — nuestro rebrand a BIRevX es fijo en el
 *     CSS del panel (src/admin/views/layout.ts), no un sistema configurable.
 *   - galeriaEnabled — Galería (el bot MANDA fotos/audios del negocio) no
 *     está portada: necesita catálogo de media (self-hosted o R2) que nadie
 *     cargó todavía. buttonsEnabled, bovedaEnabled y paymentsEnabled SÍ están
 *     portados (ver skill/botones.md, skill/boveda.md, skill/cobros.md) —
 *     paymentsEnabled SÍ es un superpoder real del paquete (vive en
 *     SUPERPOWERS de abajo, igual que salesHunter/blindaje/etc.); botones y
 *     bóveda son toggles propios sin equivalente en SUPERPOWERS.
 *   - multiLanguage — el paquete lo modela como toggle independiente; este
 *     fork lo modela como el valor especial `bot_language = "espejo"` (ver
 *     memory.md, sesión 2-ago). Semántica distinta, no un simple rename.
 *   - staffTabs, tierOverride, composioContext (excepto que SÍ se prohíbe
 *     escribir composioContext, ver NEVER_WRITABLE), brandLogo, reportTemplate
 *     — funciones de /equipo, tier remoto y el diseñador de reportes, ninguna
 *     portada.
 *
 * REGLA DE SEGURIDAD (igual que upstream): el mapa ES el whitelist. Un key sin
 * validador NO se escribe, y `NEVER_WRITABLE` fija por escrito lo que jamás
 * puede aceptarse aunque alguien le agregue un validador por descuido.
 */
import { SETTING_KEYS } from "./db/settings";

// ── Validadores de valor ─────────────────────────────────────────────────────

export const bool01 = (v: string) => v === "0" || v === "1";

/** Idioma leniente (es, es-MX, es-419, pt-BR, en, espejo), sin caracteres raros
 *  (bloquea inyección): 2 letras + sufijo opcional. */
export const langOk = (v: string) =>
  v === "" || v === "espejo" || /^[a-z]{2}(-[A-Za-z0-9]{2,4})?$/.test(v);

/** Texto corto SIN HTML (bloquea `<`/`>` en el origen: nada de XSS almacenado). */
export const shortText = (max: number) => (v: string) => v.length <= max && !/[<>]/.test(v);

/** Cerebro del bot: los MISMOS tres valores que normaliza settings-loader. */
export const modelOverrideOk = (v: string) => v === "auto" || v === "haiku" || v === "sonnet";

/** Tope mensual en USD: entero/decimal de hasta 2 cifras, 0..1000. "0" = sin
 *  tope explícito y "" = default del bot ($25) — la misma semántica que lee
 *  settings-loader. */
export const monthlyBudgetOk = (v: string) =>
  v === "" || (/^\d{1,4}(\.\d{1,2})?$/.test(v) && Number.parseFloat(v) <= 1000);

/** Instrucciones adicionales del dueño: texto libre (el LLM lo lee, no el DOM)
 *  con tope de largo. */
export const CUSTOM_INSTRUCTIONS_MAX = 16000;
export const customInstructionsOk = (v: string) => v.length <= CUSTOM_INSTRUCTIONS_MAX;

/**
 * Info del negocio (BLOB `business_context`). El texto va DENTRO de
 * <business_context>…</business_context> en el system prompt (system-prompt.ts).
 * El dueño es de confianza, pero defensa en profundidad: no vaciar (evita wipe
 * accidental), no pasarse de largo, no CERRAR el tag ni ABRIR ninguna otra
 * sección de sistema del prompt. La lista de tags refleja las secciones
 * tag-eadas del TEMPLATE de system-prompt.ts de ESTE fork (distinta a la del
 * paquete: acá no hay <botones>/<galeria>, sí <cliente>).
 */
export const BUSINESS_CONTEXT_MAX = 12000;
export const businessContextOk = (v: string): boolean =>
  v.trim().length > 0 &&
  v.length <= BUSINESS_CONTEXT_MAX &&
  !/<\/?(business_context|core_principles|anti_patterns|escalation_rules|style_guide|tools|output_language|identity_and_voice|role|moneda|brand_voice|custom_instructions|cliente)\b/i.test(
    v,
  ) &&
  !/\[\[\s*forja-app\s*:/i.test(v);

/**
 * Settings escribibles en REMOTO (control plane / Forja Inbox), CON su
 * validador de valor. Solo lo HOT + no-sensible que se administra como
 * servicio: nunca llaves, secrets, prompt override ni nada de Equipo. Cada
 * valor se valida ESTRICTO — un valor fuera de forma se rechaza (defensa en
 * profundidad aunque el writer sea de confianza).
 */
export const SETTING_VALIDATORS: Record<string, (v: string) => boolean> = {
  [SETTING_KEYS.botPaused]: bool01,
  // Epoch ms futuro razonable (10-16 dígitos) o vacío para limpiar la pausa temporal.
  [SETTING_KEYS.botPausedUntil]: (v) => v === "" || /^\d{10,16}$/.test(v),
  [SETTING_KEYS.dailyReport]: bool01,
  [SETTING_KEYS.satisfactionSurvey]: bool01,
  [SETTING_KEYS.reengageColdLeads]: bool01,
  [SETTING_KEYS.reviewRequests]: bool01,
  [SETTING_KEYS.salesHunter]: bool01,
  [SETTING_KEYS.blindajeEnabled]: (v) => v === "on" || v === "off",
  [SETTING_KEYS.surveyMode]: (v) => v === "numerico" || v === "abierto" || v === "ambos",
  [SETTING_KEYS.botLanguage]: langOk,
  [SETTING_KEYS.botCurrency]: shortText(4),
  [SETTING_KEYS.botName]: (v) => v.length >= 1 && shortText(60)(v),
  [SETTING_KEYS.tone]: shortText(300),
  [SETTING_KEYS.modelOverride]: modelOverrideOk,
  [SETTING_KEYS.monthlyBudget]: monthlyBudgetOk,
  [SETTING_KEYS.customInstructions]: customInstructionsOk,
  [SETTING_KEYS.buttonsEnabled]: bool01,
  [SETTING_KEYS.bovedaEnabled]: bool01,
  [SETTING_KEYS.paymentsEnabled]: bool01,
};

/**
 * Lista NEGRA explícita. No se aceptan JAMÁS desde la nube ni desde la app,
 * pase lo que pase: prompt override, llaves/secrets del proveedor, tools
 * crudas, business_context (tiene su propio validador con reglas distintas,
 * businessContextOk — no pasa por este mapa genérico), y el contexto cacheado
 * de Composio (que si algún día se prende, solo lo escribe el propio bot).
 */
export const NEVER_WRITABLE: readonly string[] = [
  SETTING_KEYS.systemPromptOverride,
  SETTING_KEYS.llmApiKey,
  SETTING_KEYS.llmProvider,
  SETTING_KEYS.llmModel,
  SETTING_KEYS.disabledTools,
  SETTING_KEYS.businessContext,
  SETTING_KEYS.twilioHandoffContentSid,
  SETTING_KEYS.selfOrigin,
  SETTING_KEYS.composioContext,
  SETTING_KEYS.learnedLessons,
  SETTING_KEYS.tierOverride, // solo lo mueve un POST /api/tier legítimo — no portado
] as const;

/** ¿Este key está prohibido para siempre? (fail-closed antes de cualquier set) */
export function isNeverWritable(key: string): boolean {
  return NEVER_WRITABLE.includes(key);
}

// ── Superpoderes ─────────────────────────────────────────────────────────────

/**
 * Ids públicos de los superpoderes que este bot REALMENTE tiene construidos
 * (ver memory.md, sesión 2-ago-2026: "7 superpoderes de Forja+ construidos a
 * mano"). Recortado de los 9 del paquete original — ver el comentario de
 * cabecera de este archivo para el porqué de cada exclusión.
 */
export type SuperpowerId =
  | "salesHunter"
  | "blindaje"
  | "dailyReport"
  | "satisfactionSurvey"
  | "reengage"
  | "reviews"
  | "payments";

export interface SuperpowerDef {
  id: SuperpowerId;
  /** Setting donde vive el on/off. */
  key: string;
  /** Cómo se codifica: "1"/"0" o, para el Blindaje, "on"/"off". */
  encoding: "bool01" | "onoff";
  /** Estado cuando el setting está AUSENTE (Cazador y Blindaje vienen ON). */
  defaultOn: boolean;
  /** Los 7 son Forja+ (Pro) — el gate real es el runtime (isPro en cada
   *  followup/blindaje/dailyReport/cobros), esto es solo la ficha para la app. */
  pro: boolean;
}

export const SUPERPOWERS: readonly SuperpowerDef[] = [
  { id: "salesHunter", key: SETTING_KEYS.salesHunter, encoding: "bool01", defaultOn: true, pro: true },
  { id: "blindaje", key: SETTING_KEYS.blindajeEnabled, encoding: "onoff", defaultOn: true, pro: true },
  { id: "dailyReport", key: SETTING_KEYS.dailyReport, encoding: "bool01", defaultOn: false, pro: true },
  { id: "satisfactionSurvey", key: SETTING_KEYS.satisfactionSurvey, encoding: "bool01", defaultOn: false, pro: true },
  { id: "reengage", key: SETTING_KEYS.reengageColdLeads, encoding: "bool01", defaultOn: false, pro: true },
  { id: "reviews", key: SETTING_KEYS.reviewRequests, encoding: "bool01", defaultOn: false, pro: true },
  // Opt-in real (default OFF, igual que el paquete): mandar un link de cobro
  // es una acción de dinero, no algo que se prenda solo por tener la llave
  // conectada — el dueño confirma explícitamente con el skill /cobros.
  { id: "payments", key: SETTING_KEYS.paymentsEnabled, encoding: "bool01", defaultOn: false, pro: true },
] as const;

export const SUPERPOWERS_PRO: readonly SuperpowerId[] = SUPERPOWERS.filter((s) => s.pro).map(
  (s) => s.id,
);

export function findSuperpower(id: string): SuperpowerDef | undefined {
  return SUPERPOWERS.find((s) => s.id === id);
}

/** Estado EFECTIVO de un superpoder a partir del valor crudo del setting. */
export function superpowerIsOn(def: SuperpowerDef, raw: string | undefined): boolean {
  const v = raw ?? "";
  if (def.encoding === "onoff") return def.defaultOn ? v !== "off" : v === "on";
  return def.defaultOn ? v !== "0" : v === "1";
}

/** Valor a persistir para dejar el superpoder prendido/apagado. */
export function superpowerValue(def: SuperpowerDef, on: boolean): string {
  if (def.encoding === "onoff") return on ? "on" : "off";
  return on ? "1" : "0";
}

/** Los 6 superpoderes leídos de un `settings.all()`. Los comparten
 *  GET /api/config y GET /api/maintenance: un solo lugar donde equivocarse. */
export function readSuperpowers(all: Record<string, string>): Record<SuperpowerId, boolean> {
  const out = {} as Record<SuperpowerId, boolean>;
  for (const def of SUPERPOWERS) out[def.id] = superpowerIsOn(def, all[def.key]);
  return out;
}
