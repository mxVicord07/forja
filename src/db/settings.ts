import { Db } from "./client";

// Canonical setting keys. Every value is stored as TEXT; the loader parses.
// Empty/absent => default (see settings-loader.ts).
export const SETTING_KEYS = {
  systemPromptOverride: "system_prompt_override",
  businessContext: "business_context",
  botName: "bot_name",
  tone: "tone",
  bufferSeconds: "buffer_seconds",
  maxChunks: "max_chunks",
  interChunkDelayMs: "inter_chunk_delay_ms",
  escalationKeywords: "escalation_keywords",
  modelOverride: "model_override", // auto | haiku | sonnet
  botPaused: "bot_paused", // 0 | 1
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
