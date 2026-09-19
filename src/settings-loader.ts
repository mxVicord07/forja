import type { Env } from "./env";
import { Db } from "./db/client";
import { SettingsRepo, SETTING_KEYS } from "./db/settings";
import { pauseState } from "./lib/pause-state";
import { systemPromptFromEnv } from "./system-prompt";
import { renderBusinessContext, renderBusinessHoursBlock, type BusinessHours } from "./businessContext";
import { sanitizeFaqs, renderFaqsBlock } from "./faqs";
import {
  sanitizePromo,
  renderPromoBlock,
  sanitizeLocation,
  renderLocationBlock,
  sanitizePaymentMethods,
  renderPaymentMethodsBlock,
  sanitizeCatalog,
  renderCatalogBlock,
} from "./businessInfo";
import { getBufferMs, isPro } from "./config";
import { getNiche } from "./niches";
import type { LlmOverrides } from "./llm/provider";

export type ModelOverride = "auto" | "haiku" | "sonnet";

/**
 * Tope mensual de gasto de IA cuando el dueño nunca fijó `monthly_budget`
 * (ADOPTADO del paquete Forja+ v1.0.76 al portar Forja Inbox — antes este
 * fork dejaba el bot SIN tope por default, lo cual además habría hecho que
 * `/api/cost`/`/api/maintenance` mostraran una barra de presupuesto falsa: la
 * app diría "$25 de tope" mientras el bot de verdad seguía sin ninguno).
 * SOLO baja al tier económico (Haiku) al llegar — nunca deja al bot mudo. Al
 * ritmo de gasto actual de birevx-support-bot (~$0.005 USD/mensaje) hace
 * falta ~5,000 mensajes en un mes para tocarlo: sin efecto práctico hoy, red
 * de seguridad real si el tráfico crece de golpe.
 */
export const DEFAULT_MONTHLY_BUDGET_USD = 25;

/**
 * El override manual del prompt (`system_prompt_override`), si hay uno
 * activo. Con override, el prompt GENERADO no se usa — y con él se van las
 * lecciones aprendidas y las instrucciones del dueño (Forja Inbox lo usa para
 * avisar "esta lección no se va a aplicar" al enseñarle algo al bot).
 *
 * Firma adoptada del paquete Forja+ v1.0.76 (`resolvePromptOverride(settings,
 * channel?)`), RECORTADA: el paquete resuelve prompt-por-canal + un "modo
 * boost" que sobrepone TODO temporalmente (`boost_mode`, útil para un evento)
 * — ninguno de los dos está portado en este fork (su propio skill
 * `/prompt-por-canal` es una feature separada, no incluida). `channel` se
 * acepta por compatibilidad de firma pero se ignora: este fork solo tiene el
 * override GLOBAL.
 */
export function resolvePromptOverride(
  settings: Record<string, string>,
  _channel?: string,
): string | undefined {
  const v = settings[SETTING_KEYS.systemPromptOverride];
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

export interface AgentConfig {
  systemPrompt: string;
  bufferMs: number;
  maxChunks: number;
  interChunkDelayMs: number;
  modelOverride: ModelOverride;
  botPaused: boolean;
  /** Tool names still enabled after applying the dashboard's disabled_tools. */
  enabledToolNames: string[];
  /** Sampling temperature (0-1). undefined = use the provider default. */
  temperature?: number;
  /** Monthly AI budget (USD). undefined = no cap. */
  monthlyBudgetUsd?: number;
  /** BYO-LLM del dashboard (proveedor / API key / modelo). */
  llm: LlmOverrides;
  /** Mostrar "escribiendo…" mientras se prepara la respuesta (default ON). */
  typingIndicator: boolean;
  /** Bóveda (superpoder Forja+ Pro, opt-in): archivar en R2 lo que manda el
   *  cliente. Requiere boveda_enabled="1" Y tier Pro — igual que brandVoice. */
  bovedaEnabled: boolean;
}

/** Extract the BYO-LLM overrides from a settings snapshot. */
export function llmOverridesFrom(settings: Record<string, string>): LlmOverrides {
  const pick = (key: string): string | undefined => {
    const v = settings[key];
    return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
  };
  return {
    provider: pick(SETTING_KEYS.llmProvider),
    apiKey: pick(SETTING_KEYS.llmApiKey),
    model: pick(SETTING_KEYS.llmModel),
  };
}

/** Load just the BYO-LLM overrides (para analyzer/flywheel/admin, fuera del agente).
 *  Nunca truena: si settings no está disponible, se usan los defaults del env. */
export async function loadLlmOverrides(env: Env): Promise<LlmOverrides> {
  try {
    const settings = await new SettingsRepo(new Db(env.DB)).all();
    return llmOverridesFrom(settings);
  } catch {
    return {};
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function normalizeModelOverride(value: string | undefined): ModelOverride {
  if (value === "haiku" || value === "sonnet" || value === "auto") return value;
  return "auto";
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** JSON de un setting → valor saneado. Fail-open: JSON ausente o malformado
 *  cae al `sanitize` con `undefined` (que cada sanitizador trata como "vacío"),
 *  nunca lanza — un dato corrupto en un campo de Forja Inbox no puede tumbar
 *  la resolución del prompt. */
function parseSetting<T>(raw: string | undefined, sanitize: (v: unknown) => T): T {
  if (!raw) return sanitize(undefined);
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return sanitize(undefined);
  }
}

/**
 * Resolve the effective agent config by overlaying D1 `settings` on top of env
 * defaults. Anything empty/absent in settings falls back to the env/default.
 */
export async function resolveAgentConfig(env: Env, toolNames: string[]): Promise<AgentConfig> {
  const repo = new SettingsRepo(new Db(env.DB));
  const settings = await repo.all();

  const get = (key: string): string | undefined => {
    const v = settings[key];
    return v !== undefined && v.trim() !== "" ? v : undefined;
  };

  // Niche pack activo (BOT_NICHE). Aporta el playbook del giro y un tono por
  // defecto; ambos se pueden sobreescribir desde el panel.
  const niche = getNiche(env);

  const systemPromptOverride = get(SETTING_KEYS.systemPromptOverride);
  // Reglas del dueño que se SUMAN al prompt GENERADO (mismo trato que las
  // lecciones): con un override manual activo no aplican — el override es
  // "úsalo tal cual", y el panel lo advierte junto al campo.
  const customInstructions = get(SETTING_KEYS.customInstructions);
  const businessContextBase = get(SETTING_KEYS.businessContext) ?? renderBusinessContext();
  // Campos editables desde Forja Inbox: se SUMAN al final, nunca reemplazan la
  // fuente de arriba (override manual o member/config.local) — regla del
  // paquete original, "no destruir config del dueño". Cada bloque es "" si el
  // campo está vacío/nunca se tocó desde la app, así que un bot que nadie
  // administra desde el celular queda con el prompt IDÉNTICO al de siempre.
  const extraBlocks: string[] = [];
  const rawHours = get(SETTING_KEYS.businessHours);
  if (rawHours) {
    try {
      const parsed = JSON.parse(rawHours) as Partial<BusinessHours>;
      if (parsed && typeof parsed === "object" && parsed.days) {
        const block = renderBusinessHoursBlock(parsed as BusinessHours);
        if (block) extraBlocks.push(block);
      }
    } catch {
      // horario estructurado corrupto — se ignora, no tumba el prompt
    }
  }
  extraBlocks.push(renderFaqsBlock(parseSetting(get(SETTING_KEYS.faqs), sanitizeFaqs)));
  extraBlocks.push(renderPromoBlock(parseSetting(get(SETTING_KEYS.promo), sanitizePromo)));
  extraBlocks.push(renderLocationBlock(parseSetting(get(SETTING_KEYS.location), sanitizeLocation)));
  extraBlocks.push(
    renderPaymentMethodsBlock(parseSetting(get(SETTING_KEYS.paymentMethods), sanitizePaymentMethods)),
  );
  extraBlocks.push(renderCatalogBlock(parseSetting(get(SETTING_KEYS.catalog), sanitizeCatalog)));
  const businessContext = [businessContextBase, ...extraBlocks.filter(Boolean)].join("\n\n");
  const botName = get(SETTING_KEYS.botName) ?? env.BOT_NAME;
  // Tono elegido en el panel gana; si no hay, el tono por defecto del nicho.
  const tone = get(SETTING_KEYS.tone) ?? (niche.defaultTone || undefined);
  const escalationKeywords = parseCsvList(get(SETTING_KEYS.escalationKeywords));
  const formattingRules = get(SETTING_KEYS.formattingRules);
  const language = get(SETTING_KEYS.botLanguage);
  // Voz de marca (skill /voz-de-marca): guía completa, solo Pro — igual que el
  // resto de los superpoderes. En free el bot se queda con `tone` (3 tarjetas).
  const brandVoice = isPro(env) ? get(SETTING_KEYS.brandVoice) : undefined;

  // Flywheel lessons (JSON array). Only injected into the GENERATED prompt —
  // a manual override replaces the whole prompt, lessons included.
  let lessons: string[] = [];
  try {
    const parsed = JSON.parse(get(SETTING_KEYS.learnedLessons) ?? "[]");
    if (Array.isArray(parsed)) lessons = parsed.filter((l) => typeof l === "string");
  } catch { /* malformed setting — ignore */ }

  // Dashboard tool toggles: the prompt only advertises the enabled tools, so
  // the model never tries to call something that was turned off.
  const disabledTools = parseCsvList(get(SETTING_KEYS.disabledTools));
  // Cobros (skill /cobros): opt-in real, default OFF — a diferencia de
  // disabled_tools (todo ENCENDIDO salvo lo que el dueño apague),
  // sendPaymentLink empieza APAGADO aunque buildTools() ya la haya registrado
  // (isPro + stripeConfigured), hasta que el dueño confirme con "1".
  const paymentsEnabled = get(SETTING_KEYS.paymentsEnabled) === "1";
  const enabledToolNames = toolNames.filter(
    (n) => !disabledTools.includes(n) && (n !== "sendPaymentLink" || paymentsEnabled),
  );

  // Botones tocables (opt-in, skill /botones): default OFF, "1" lo prende.
  const buttonsEnabled = get(SETTING_KEYS.buttonsEnabled) === "1";

  const systemPrompt =
    systemPromptOverride ??
    systemPromptFromEnv(env, enabledToolNames, businessContext, niche.playbook || undefined, {
      tone,
      extraEscalationKeywords: escalationKeywords,
      botName,
      buttonsEnabled,
      lessons,
      formattingRules,
      brandVoice,
      language,
      customInstructions,
    });

  const bufferSecondsRaw = get(SETTING_KEYS.bufferSeconds);
  const bufferMs =
    bufferSecondsRaw !== undefined
      ? Math.max(1000, parseIntOr(bufferSecondsRaw, 1) * 1000)
      : getBufferMs(env);

  const maxChunks = clamp(parseIntOr(get(SETTING_KEYS.maxChunks), 3), 1, 5);
  const interChunkDelayMs = clamp(parseIntOr(get(SETTING_KEYS.interChunkDelayMs), 1000), 0, 5000);
  const modelOverride = normalizeModelOverride(get(SETTING_KEYS.modelOverride));
  // OR del switch manual y la pausa temporal con vencimiento que escribe
  // Forja Inbox (POST /api/pause) — ver lib/pause-state.ts. Sobrevive sola
  // aunque nadie la apague a mano: una vez pasado `bot_paused_until` deja de
  // contar, sin necesidad de un cron que la limpie.
  const botPaused = pauseState(get(SETTING_KEYS.botPaused), get(SETTING_KEYS.botPausedUntil)).paused;
  // Default ON: solo un "0" explícito lo apaga.
  const typingIndicator = get(SETTING_KEYS.typingIndicator) !== "0";
  // Bóveda (skill /boveda): opt-in, default OFF, y Pro — igual que brandVoice.
  const bovedaEnabled = isPro(env) && get(SETTING_KEYS.bovedaEnabled) === "1";

  const tempRaw = get(SETTING_KEYS.temperature);
  let temperature: number | undefined;
  if (tempRaw !== undefined) {
    const t = Number.parseFloat(tempRaw);
    if (!Number.isNaN(t)) temperature = clamp(t, 0, 1);
  }

  const budgetRaw = get(SETTING_KEYS.monthlyBudget);
  let monthlyBudgetUsd: number | undefined;
  if (budgetRaw === undefined) {
    // Nunca lo tocó el dueño → el default sugerido, DE VERDAD (ver el
    // comentario de DEFAULT_MONTHLY_BUDGET_USD arriba: antes de portar Forja
    // Inbox este fork se quedaba sin tope aquí, lo cual dejaba a la app
    // mostrando un presupuesto falso). "0" explícito sigue significando "sin
    // tope" — solo la AUSENCIA del setting cae al default.
    monthlyBudgetUsd = DEFAULT_MONTHLY_BUDGET_USD;
  } else {
    const b = Number.parseFloat(budgetRaw);
    if (!Number.isNaN(b) && b > 0) monthlyBudgetUsd = b;
  }

  return {
    systemPrompt,
    bufferMs,
    maxChunks,
    interChunkDelayMs,
    modelOverride,
    botPaused,
    enabledToolNames,
    temperature,
    monthlyBudgetUsd,
    llm: llmOverridesFrom(settings),
    typingIndicator,
    bovedaEnabled,
  };
}
