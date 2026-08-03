/**
 * Blindaje anti-invento — verificador pre-envío (Pro).
 *
 * Antes de que el bot MANDE una respuesta que afirme datos del negocio
 * (precios, horarios, promociones, políticas), un modelo rápido la contrasta
 * contra las fuentes de verdad del turno: los pasajes que searchKb recuperó
 * de la base de conocimiento + el contexto del negocio + el system prompt
 * activo. Si la afirmación no tiene respaldo, la respuesta se reemplaza por
 * un "déjame confirmarlo con el equipo" en el idioma del bot y se abre un
 * ticket con aviso al dueño (mismo mecanismo que handoffHuman) para que él
 * conteste con el dato real.
 *
 * Regla de oro: FAIL-OPEN. Cualquier error/timeout del verificador manda la
 * respuesta original intacta — este módulo JAMÁS bloquea un envío. Solo corre
 * en el tier Pro y solo cuando la respuesta huele a dato (dígitos, moneda,
 * porcentajes) o hubo búsqueda en KB este turno.
 */
import type { Env } from "../env";
import { isPro } from "../config";
import { createModel, type LlmOverrides } from "../llm/provider";
import type { SearchKbResult } from "../tools/searchKb";
import { Db } from "../db/client";
import { SettingsRepo, SETTING_KEYS } from "../db/settings";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { notifyOwner } from "../tools/handoffHuman";

/** Tope duro del verificador: si el modelo no contesta a tiempo, fail-open. */
export const VERIFY_TIMEOUT_MS = 4000;

export interface VerifyVerdict {
  supported: boolean;
  unsupported_claim?: string;
}

// Huele a dato factual: dígitos (precios, horarios, plazos), símbolos de
// moneda/porcentaje o palabras de dinero. Barato a propósito — el veredicto
// fino lo da el modelo; esto solo decide SI vale la pena preguntarle.
const CLAIM_PATTERN = /[0-9$€£%]|\bpesos?\b|\bd[oó]lares?\b|\bmxn\b|\busd\b|\bgratis\b|\bfree\b/i;

/**
 * ¿Amerita verificación? Sí cuando la respuesta trae señales de dato duro
 * (precio/moneda/dígitos/horas/porcentajes) O cuando searchKb corrió este
 * turno (el bot está contestando "con fuentes" — hay que checar que no las
 * haya torcido).
 */
export function shouldVerify(replyText: string, turnUsedKb: boolean): boolean {
  if (turnUsedKb) return true;
  return CLAIM_PATTERN.test(replyText);
}

// Respuesta segura en el tono del bot, por idioma (BOT_LANGUAGE). Español por
// default — es el mercado del template.
const SAFE_REPLY_BY_LANG: Record<string, string> = {
  "es-419": "Esa me la confirma el equipo — dame un momento y te digo bien, para no darte un dato equivocado.",
  "es-ES": "Eso me lo confirma el equipo — dame un momento y te digo seguro, para no darte un dato equivocado.",
  en: "Let me double-check that with the team so I don't give you the wrong info — I'll get back to you in a moment.",
  "pt-BR": "Deixa eu confirmar isso com a equipe para não te passar um dado errado — já te retorno.",
};

/**
 * Indexa por el idioma REAL del bot (BOT_LANGUAGE es "es"/"en"/"pt", no
 * "es-MX"/"en-US"): comparar contra el valor crudo nunca haría match y todo
 * caería al español, incluso un bot en inglés en el momento más delicado
 * (cuando el blindaje frena un dato inventado).
 */
export function safeConfirmReply(lang: string | undefined): string {
  const v = (lang ?? "").trim().toLowerCase();
  if (v === "es-es" || v === "es_es") return SAFE_REPLY_BY_LANG["es-ES"];
  if (v.startsWith("pt")) return SAFE_REPLY_BY_LANG["pt-BR"];
  if (v.startsWith("en")) return SAFE_REPLY_BY_LANG.en;
  return SAFE_REPLY_BY_LANG["es-419"];
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[blindaje] verify timeout tras ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifyOptions {
  /** BYO-LLM del dashboard (cfg.llm) — mismo override que usa el chat. */
  llm?: LlmOverrides;
  /** Solo para tests; default VERIFY_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * System prompt activo del bot — fuente OFICIAL igual que la KB. Sin esto,
   * todo dato que viva en la persona (fechas de evento, precios, promos) se
   * marca como "sin respaldo" aunque sea correcto.
   */
  systemPrompt?: string;
}

/**
 * UNA llamada al modelo rápido con veredicto JSON estricto. Lanza en cualquier
 * anomalía (timeout, JSON inválido, campo faltante) — el caller decide el
 * fail-open, no este módulo.
 */
export async function verifyReply(
  env: Env,
  replyText: string,
  kbPassages: SearchKbResult[],
  businessContext: string,
  opts: VerifyOptions = {},
): Promise<VerifyVerdict> {
  const { model } = createModel(env, "fast", opts.llm);
  // Import dinámico como el resto de rutas no-críticas del agente: los tests
  // del agente mockean "ai" sin generateText y nunca deben resolverlo.
  const { generateText } = await import("ai");

  const passagesBlock =
    kbPassages.length > 0
      ? kbPassages
          .map((p, i) => `[${i + 1}] ${p.title ? `${p.title} — ` : ""}${p.content.slice(0, 1500)}`)
          .join("\n")
      : "(no se consultó la base de conocimiento este turno)";

  const result = await withTimeout(
    generateText({
      model,
      prompt: `Eres un verificador de datos para el bot de atención de ${env.BUSINESS_NAME}.
Tu ÚNICO trabajo: decidir si los DATOS FACTUALES del negocio que afirma la respuesta del bot (precios, horarios, direcciones, políticas, promociones, descuentos, disponibilidad, plazos) están respaldados por las fuentes de abajo.

Reglas:
- Solo cuentan afirmaciones factuales sobre el negocio. Saludos, cortesía, preguntas al cliente o frases sin datos NO son afirmaciones.
- Una afirmación está respaldada si las fuentes dicen lo mismo (mismas cifras, mismos horarios). Parafrasear está bien; cambiar números no.
- Si la respuesta no afirma ningún dato factual del negocio, responde supported=true.
- Si una cifra, promesa o descuento NO aparece en las fuentes, responde supported=false.

FUENTES (información oficial del negocio — las TRES cuentan igual como respaldo):
<contexto_negocio>
${businessContext || "(vacío)"}
</contexto_negocio>
<instrucciones_oficiales_del_bot>
${(opts.systemPrompt ?? "").slice(0, 24000) || "(sin instrucciones)"}
</instrucciones_oficiales_del_bot>
<pasajes_kb>
${passagesBlock}
</pasajes_kb>

RESPUESTA DEL BOT A VERIFICAR:
<respuesta>
${replyText}
</respuesta>

Responde SOLO con JSON válido, sin markdown ni explicación:
{"supported": true|false, "unsupported_claim": "la afirmación exacta sin respaldo (solo si supported=false)"}`,
    }),
    opts.timeoutMs ?? VERIFY_TIMEOUT_MS,
  );

  const raw = (result.text ?? "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`[blindaje] el verificador no devolvió JSON: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  if (typeof parsed.supported !== "boolean") {
    throw new Error("[blindaje] veredicto sin campo booleano 'supported'");
  }
  return {
    supported: parsed.supported,
    unsupported_claim:
      typeof parsed.unsupported_claim === "string" && parsed.unsupported_claim.trim() !== ""
        ? parsed.unsupported_claim
        : undefined,
  };
}

// Contadores para el panel (settings). Nunca ruta crítica: si D1 falla, el
// envío sigue igual.
async function bumpCounter(env: Env, key: string): Promise<void> {
  try {
    const repo = new SettingsRepo(new Db(env.DB));
    const current = parseInt((await repo.get(key)) ?? "0", 10) || 0;
    await repo.set(key, String(current + 1));
  } catch {
    /* contador es cosmético — jamás tumba el envío */
  }
}

export type GuardAction =
  | "skipped-free" // tier free: el verificador es Pro-only
  | "skipped-off" // el dueño apagó blindaje_enabled
  | "skipped-no-claims" // la respuesta no afirma datos y no hubo KB este turno
  | "sent-original" // verificada y respaldada — sale tal cual
  | "replaced" // sin respaldo — sale el "déjame confirmarlo" + ticket
  | "fail-open"; // el verificador falló/timeout — sale la original intacta

export interface GuardOptions {
  replyText: string;
  turnUsedKb: boolean;
  kbPassages: SearchKbResult[];
  businessContext?: string;
  /** System prompt activo — fuente oficial para el verificador (ver VerifyOptions). */
  systemPrompt?: string;
  conversationId: string | null;
  llm?: LlmOverrides;
  /** Solo para tests; default VERIFY_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface GuardResult {
  finalText: string;
  action: GuardAction;
  unsupportedClaim?: string;
}

/**
 * Punto de entrada del agente: decide qué texto sale al cliente. Nunca lanza
 * — cualquier falla interna resuelve a la respuesta original (fail-open).
 */
export async function guardReply(env: Env, opts: GuardOptions): Promise<GuardResult> {
  const original = opts.replyText;

  if (!isPro(env)) return { finalText: original, action: "skipped-free" };

  const settings = new SettingsRepo(new Db(env.DB));
  if ((await settings.get(SETTING_KEYS.blindajeEnabled)) === "off") {
    return { finalText: original, action: "skipped-off" };
  }

  if (!shouldVerify(original, opts.turnUsedKb)) {
    return { finalText: original, action: "skipped-no-claims" };
  }

  let verdict: VerifyVerdict;
  try {
    verdict = await verifyReply(env, original, opts.kbPassages, opts.businessContext ?? "", {
      llm: opts.llm,
      timeoutMs: opts.timeoutMs,
      systemPrompt: opts.systemPrompt,
    });
  } catch (e) {
    console.warn("[blindaje] verificador falló — fail-open, va la respuesta original:", e);
    return { finalText: original, action: "fail-open" };
  }

  await bumpCounter(env, SETTING_KEYS.blindajeChecks);

  if (verdict.supported) return { finalText: original, action: "sent-original" };

  const claim = (verdict.unsupported_claim ?? original).slice(0, 200);

  // Ticket + aviso al dueño con el mismo mecanismo del handoff (TicketsRepo +
  // ConversationsRepo.setOpenTicket + notifyOwner) — cero duplicación de la
  // maquinaria de aviso. Best-effort: si el ticket falla, la respuesta segura
  // sale igual — nunca dejamos pasar el dato sin respaldo por un error de D1.
  try {
    const db = new Db(env.DB);
    const ticketId = await new TicketsRepo(db).create({
      conversationId: opts.conversationId,
      category: "other",
      summary: `[dato sin respaldo] El bot iba a afirmar un dato que no está en tu información: "${claim}". Se le dijo al cliente que lo confirmas tú.`,
      transcript: "",
    });
    if (opts.conversationId) {
      await new ConversationsRepo(db).setOpenTicket(opts.conversationId, ticketId);
    }
    await notifyOwner(env, {
      reason: "dato sin respaldo",
      summary: `El bot iba a afirmar un dato que no está en tu información: "${claim}". Se le dijo al cliente que lo confirmas tú.`,
      ticketId,
    });
  } catch (e) {
    console.error("[blindaje] no se pudo crear el ticket/aviso:", e);
  }

  await bumpCounter(env, SETTING_KEYS.blindajeBlocked);
  console.warn(`[blindaje] respuesta reemplazada (dato sin respaldo): "${claim.slice(0, 120)}"`);

  return {
    finalText: safeConfirmReply(env.BOT_LANGUAGE),
    action: "replaced",
    unsupportedClaim: claim,
  };
}
