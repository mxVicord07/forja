import { Db } from "./client";
import type { Env } from "../env";

// Canonical setting keys. Every value is stored as TEXT; the loader parses.
// Empty/absent => default (see settings-loader.ts).
export const SETTING_KEYS = {
  systemPromptOverride: "system_prompt_override",
  // Reglas del dueño que se SUMAN al prompt generado; NO lo reemplazan (eso es
  // system_prompt_override). Es el campo seguro para "siempre ofrece agendar
  // cita" sin perder el contexto del negocio, el playbook ni el KB.
  customInstructions: "custom_instructions",
  businessContext: "business_context",
  botName: "bot_name",
  tone: "tone",
  bufferSeconds: "buffer_seconds",
  maxChunks: "max_chunks",
  interChunkDelayMs: "inter_chunk_delay_ms",
  escalationKeywords: "escalation_keywords",
  modelOverride: "model_override", // auto | haiku | sonnet
  botPaused: "bot_paused", // 0 | 1
  // Pausa TEMPORAL con vencimiento (epoch ms) — la escribe POST /api/pause desde
  // Forja Inbox ("pausar 1 hora", "hasta mañana 9:00"). Distinta del switch
  // manual de arriba: se combina con él por OR en settings-loader (ver
  // lib/pause-state.ts), y expira sola sin que nadie la apague a mano.
  botPausedUntil: "bot_paused_until",
  disabledTools: "disabled_tools", // comma-separated tool names turned off from the dashboard
  temperature: "temperature", // LLM sampling temperature 0-1; empty = provider default
  monthlyBudget: "monthly_budget", // USD cap for monthly AI spend; empty = no cap
  learnedLessons: "learned_lessons", // JSON array of rules distilled from owner takeovers
  twilioHandoffContentSid: "twilio_handoff_content_sid", // HSM del aviso de handoff (fallback del secret)
  autonomyLevel: "autonomy_level", // flywheel: manual (default) | copilot (auto-aplica lo seguro de noche)
  // BYO-LLM (dashboard "Modelo de IA"): the owner plugs their own provider,
  // API key and/or concrete model. Empty = the instance's env defaults.
  llmProvider: "llm_provider", // "" (auto) | anthropic | openai
  llmApiKey: "llm_api_key", // owner's API key; empty = use the env key
  llmModel: "llm_model", // concrete model id; empty = auto tiers (fast⇄smart)
  // Formatting rules (bold/emoji usage) injected INSIDE <style_guide> — same
  // section the model already treats as authoritative for chat formatting,
  // instead of competing from a different section like `tone` does.
  formattingRules: "formatting_rules",
  // Overrides env.BOT_LANGUAGE without a redeploy. Special value "espejo" =
  // detect and mirror the customer's language turn by turn instead of a
  // single fixed language.
  botLanguage: "bot_language",
  // Guía de voz completa armada por el skill /voz-de-marca. Solo se aplica en
  // Pro (gateado con isPro en settings-loader.ts) — free se queda con `tone`.
  brandVoice: "brand_voice",
  // Cazador de ventas (Pro): interruptor del dueño, independiente del tier.
  // "0" = apagado; ausente o "1" = encendido (default ON en Pro).
  salesHunter: "sales_hunter",
  // Blindaje anti-invento (Pro): interruptor del dueño ("off" = apagado,
  // ausente/cualquier otro valor = encendido — viene ON por default en Pro).
  blindajeEnabled: "blindaje_enabled",
  // Contadores cosméticos para el panel: cuántas veces verificó, cuántas
  // reemplazó. Nunca ruta crítica — si D1 falla al escribirlos, el envío
  // del bot sigue igual.
  blindajeChecks: "blindaje_checks",
  blindajeBlocked: "blindaje_blocked",
  // Reporte diario (Pro): interruptor del dueño — "1" = encendido; ausente o
  // cualquier otro valor = apagado (a diferencia de blindaje/sales_hunter,
  // este SÍ default OFF: mandar un mensaje no pedido es un opt-in explícito).
  dailyReport: "daily_report",
  // Marca de tiempo del último envío — throttle para no duplicar en el
  // doble-tick del cron.
  dailyReportLastAt: "daily_report_last_at",
  // Encuesta de satisfacción (Pro): interruptor del dueño — "1" = encendido,
  // default OFF (opt-in, igual que daily_report).
  satisfactionSurvey: "satisfaction_survey",
  // "numerico" (default) | "abierto" | "ambos" — qué le pide la encuesta al cliente.
  surveyMode: "survey_mode",
  // Pide reseñas (Pro): comparte motor con la encuesta (followup/outreach.ts).
  // Inactiva hasta que además haya reviewUrl configurada.
  reviewRequests: "review_requests",
  reviewUrl: "review_url",
  // Reactivación de leads fríos (Pro): interruptor del dueño, default OFF
  // (opt-in, igual que los demás superpoderes de mensaje saliente).
  reengageColdLeads: "reengage_cold_leads",
  // Indicador nativo de "escribiendo…" (los tres puntitos) mientras el bot
  // prepara la respuesta. "0" = apagado; ausente o cualquier otro valor =
  // encendido. Default ON: es señal de vida, no un mensaje saliente no pedido
  // (a diferencia de daily_report/encuesta, que sí son opt-in explícito).
  typingIndicator: "typing_indicator",

  // ── Forja Inbox (app de iPhone) — porteadas del paquete Forja+ v1.0.76 ────
  // Símbolo de moneda con el que el bot habla de precios ($ | € | R$…). NO
  // afecta la tab Costos: esa va en USD porque los proveedores de IA facturan
  // en dólares y convertirla sería inventar un tipo de cambio.
  botCurrency: "bot_currency",
  // Auto-cura del origin: base URL real del worker aprendida de las requests
  // entrantes cuando DASHBOARD_BASE_URL viene vacío. Ver src/lib/self-origin.ts.
  selfOrigin: "self_origin",
  // Plantilla HSM aprobada para reenganchar FUERA de la ventana de 24h vía
  // Cloud API oficial (Meta): nombre + idioma de la plantilla. Vacío = fuera
  // de ventana no reengancha por WhatsApp Cloud API (YCloud usa su propio
  // TWILIO_HANDOFF_CONTENT_SID-equivalente, sin tocar).
  reengageTemplateName: "reengage_template_name",
  reengageTemplateLang: "reengage_template_lang", // idioma de la plantilla (es, es_MX, en_US…); default es
  // Respuestas rápidas que el dueño arma desde la app — botones de un toque
  // al responder un chat desde Forja Inbox. JSON array de strings.
  quickReplies: "quick_replies",
  // Campos ESTRUCTURADOS de negocio, editables desde la app (GET/PUT en
  // api-inbox.ts) — complementan, no reemplazan, el `business_context` de
  // texto libre que ya usa el prompt (businessContext.ts). Vacíos por default:
  // un bot que nunca abre estas pantallas de la app se comporta igual que hoy.
  businessHours: "business_hours",
  faqs: "faqs",
  promo: "promo", // oferta vigente con on/off + vencimiento
  location: "location", // ubicación y cobertura
  paymentMethods: "payment_methods", // formas de pago
  catalog: "catalog", // servicios y precios (lista corta)
  // Caché del catálogo de tools/contexto de Composio (integrations/composio.ts)
  // — auto-descubierto por el propio bot, JAMÁS escribible desde afuera (ver
  // NEVER_WRITABLE en settings-mutations.ts). Vacío mientras no haya
  // COMPOSIO_API_KEY configurado.
  composioContext: "composio_context",
  // Tier EFECTIVO empujado por el control plane (ver src/tier.ts). Vacío =
  // manda el BOT_TIER de wrangler.toml — que es el único caso real hoy: no se
  // portó ningún POST /api/tier que lo escriba, así que este siempre gana el
  // fallback estático. Se deja portado para cuando (si) se conecte ese push.
  tierOverride: "tier_override",
  // Cuánto se queda callado el bot tras una intervención del dueño (vacío =
  // 60 min default, "0" = hasta que el dueño reactive). Editable desde el
  // skill /human-in-the-loop y desde Forja Inbox (Centro de Mantenimiento).
  // Ver resolveTakeoverMs abajo — reemplaza el TAKEOVER_MS fijo que tenía
  // admin/routes.ts.
  takeoverMinutes: "takeover_minutes",
  // Botones tocables (opt-in, default OFF): "1" enseña al modelo el marcador
  // [[botones: …]] en el prompt generado (system-prompt.ts) — el runtime
  // (agent.ts + replies/sender.ts) lo traduce a botones nativos donde el canal
  // los soporta (channels/shared.ts#BUTTON_CHANNELS), o a lista numerada en
  // texto donde no. Skill /botones lo prende y ayuda a configurar cuándo usarlo.
  buttonsEnabled: "buttons_enabled",
  // Bóveda (superpoder Forja+ Pro, opt-in, default OFF): "1" archiva en el R2
  // del miembro (binding MEDIA) las imágenes/audios/documentos que mandan los
  // clientes — ver src/media/boveda.ts (captureIncomingMedia, llamado desde
  // agent.ts#ingest) y el tab /admin/boveda. Sin binding MEDIA, prender esto
  // no hace nada (captureIncomingMedia se sale en silencio). Skill /boveda.
  bovedaEnabled: "boveda_enabled",
  // Cobros por WhatsApp (superpoder Forja+ Pro, opt-in, default OFF): "1"
  // registra la tool sendPaymentLink (ver src/tools/cobros.ts) — además
  // requiere el secret STRIPE_SECRET_KEY configurado (stripeConfigured()).
  // "0" pausa los cobros SIN quitar la llave. Skill /cobros.
  paymentsEnabled: "payments_enabled",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

interface SettingRow {
  key: string;
  value: string;
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.first<SettingRow>(
      "SELECT value FROM settings WHERE key = ?",
      [key],
    );
    return row?.value ?? null;
  }

  async set(key: string, value: string, actor: "owner" | "flywheel" | "system" = "system"): Promise<void> {
    const previous = await this.get(key);
    if (previous === value) {
      await this.db.run(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, Date.now()],
      );
      return;
    }
    const now = Date.now();
    await this.db.batch([
      {
        sql: `INSERT INTO settings_history (key, old_value, new_value, actor, changed_at) VALUES (?, ?, ?, ?, ?)`,
        params: [key, previous, value, actor, now],
      },
      {
        sql: `INSERT INTO settings (key, value, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        params: [key, value, now],
      },
    ]);
  }

  async all(): Promise<Record<string, string>> {
    const rows = await this.db.all<SettingRow>(
      "SELECT key, value FROM settings",
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = row.value;
    }
    return out;
  }
}

const DEFAULT_TAKEOVER_MIN = 60;
/** "hasta reactivar" (pausa ≈ 1 año) — lo que ya usaba admin/routes.ts para "0". */
export const MANUAL_RESUME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Cuánto se queda callado el bot tras una intervención del dueño (setting
 * `takeoverMinutes`: vacío = 60 min, 0 = hasta que el dueño reactive).
 * REEMPLAZA el `TAKEOVER_MS` fijo de 60 min que tenía admin/routes.ts —
 * ahora configurable desde /human-in-the-loop y desde Forja Inbox.
 */
export async function resolveTakeoverMs(env: Env): Promise<number> {
  const raw = ((await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.takeoverMinutes)) ?? "").trim();
  const min = raw === "" ? DEFAULT_TAKEOVER_MIN : parseInt(raw, 10);
  if (!Number.isFinite(min)) return DEFAULT_TAKEOVER_MIN * 60_000;
  return min <= 0 ? MANUAL_RESUME_MS : min * 60_000;
}
