/**
 * Reactivación de leads fríos (superpoder Pro) — SEGUNDO toque a los leads
 * calientes que se enfriaron por DÍAS. El follow-up (followup/run.ts) da el
 * primer toque dentro de las 24h; este reengancha a los que aun así no
 * volvieron, entre 2 y 7 días después, una sola vez.
 *
 * Entrega honesta por canal: 2-7 días cae SIEMPRE fuera de la ventana de 24h
 * de mensajes iniciados por el negocio en WhatsApp/Twilio/ManyChat/Messenger
 * (2 días > 24h, sin excepción) — ahí Meta exige una plantilla (HSM)
 * pre-aprobada, que este bot no tiene configurada. En vez de inventar un
 * envío que el proveedor rechazaría, esos candidatos se saltan SIN quemar
 * el claim: pueden reengancharse después si algún día se conecta una
 * plantilla. Solo Telegram (sin ventana de 24h) reengancha hoy.
 *
 * Claim-before-send en reengage_sends (PRIMARY KEY = candado). Best-effort.
 */
import { generateText } from "ai";
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { resolveAgentConfig, loadLlmOverrides } from "../settings-loader";
import { createModel } from "../llm/provider";
import { SettingsRepo, SETTING_KEYS } from "../db/settings";
import { isPro } from "../config";
import { sendOutbound } from "./send";
import type { ChannelId } from "../channels/shared";
import { sendYCloudTemplate } from "../channels/ycloud";
import { campanasPorPlantillaBloqueadas } from "../campaigns";
import { ConversationsRepo } from "../db/conversations";

/**
 * Reactivación por plantilla (I-034): fuera de la ventana de 24 h, WhatsApp solo acepta una plantilla aprobada.
 * Con REENGAGE_PLANTILLA (2 variables: {{1}} nombre, {{2}} tema, como `retomar_conversacion_v1`) el lead frío de
 * WhatsApp sí recibe su segundo toque. No aplica en un bot conectado al CRM: ahí el seguimiento lo lleva el CRM
 * con su guarda de consentimiento.
 */
export function plantillaReenganche(env: Env): { name: string; language: string } | null {
  const name = (env.REENGAGE_PLANTILLA ?? "").trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return null;
  if ((env.WA_PROVIDER ?? "").trim().toLowerCase() !== "ycloud" || campanasPorPlantillaBloqueadas(env)) return null;
  return { name, language: (env.REENGAGE_PLANTILLA_IDIOMA ?? "es_MX").trim() };
}

/** Tema corto para la plantilla: el primer tema que detectó el Analista, o una frase neutra. Nunca texto del cliente tal cual. */
export function temaReenganche(topicsRaw: string | null): string {
  try {
    const t = JSON.parse(topicsRaw ?? "[]");
    const primero = Array.isArray(t) ? t.find((x) => typeof x === "string" && x.trim()) : null;
    if (primero) return String(primero).replace(/\s+/g, " ").trim().slice(0, 60);
  } catch { /* temas mal formados: frase neutra */ }
  return "lo que platicamos";
}

const MIN_COLD_MS = 2 * 24 * 60 * 60 * 1000; // 2 días
const MAX_COLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

/** Canales con ventana de 24h para mensajes iniciados por el negocio — un
 *  lead frío (2+ días) siempre está fuera de esta ventana en estos canales. */
const WINDOWED: ReadonlySet<string> = new Set(["twilio", "whatsapp", "ycloud", "manychat", "messenger"]);

interface CandidateRow {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  sale_opportunity: number | null;
  topics: string | null;
  kw_hits: number;
  last_user_at: number;
}

export interface ReengageResult {
  sent: number;
  skipped: number;
  errors: number;
}

export async function runReengage(
  env: Env,
  opts: { now?: number; limit?: number; dailyCap?: number } = {},
): Promise<ReengageResult> {
  const empty: ReengageResult = { sent: 0, skipped: 0, errors: 0 };
  if (!isPro(env)) return empty;

  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 5;
  const dailyCap = opts.dailyCap ?? 20;
  const db = new Db(env.DB);

  const settings = new SettingsRepo(db);
  if ((await settings.get(SETTING_KEYS.reengageColdLeads)) !== "1") return empty;

  const cfg = await resolveAgentConfig(env, []);
  if (cfg.botPaused) return empty;

  const sentToday =
    (
      await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM reengage_sends WHERE sent_at > ?", [
        now - 24 * 60 * 60 * 1000,
      ])
    )?.n ?? 0;
  if (sentToday >= dailyCap) return empty;

  // env.INTERNAL_CHANNEL (equipo interno, no clientes): nunca lo alcanza un
  // reenganche de lead frío, igual que Instagram queda fuera por su razón.
  const internalChannel = env.INTERNAL_CHANNEL?.trim();
  const rows = await db.all<CandidateRow>(
    `SELECT c.id, c.channel, c.channel_user_id, c.display_name,
       i.sale_opportunity, i.topics,
       (SELECT COUNT(*) FROM keyword_hits k WHERE k.conversation_id = c.id) AS kw_hits,
       (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS last_user_at
     FROM conversations c
     LEFT JOIN conversation_insights i ON i.conversation_id = c.id
     LEFT JOIN reengage_sends re ON re.conversation_id = c.id
     WHERE re.conversation_id IS NULL
       AND c.open_ticket_id IS NULL
       AND c.channel != 'instagram'
       ${internalChannel ? "AND c.channel != ?" : ""}
       AND (c.paused_until IS NULL OR c.paused_until < ?)
     GROUP BY c.id
     HAVING last_user_at IS NOT NULL
       AND last_user_at <= ? AND last_user_at >= ?
       AND (COALESCE(i.sale_opportunity, 0) = 1 OR kw_hits > 0)
     ORDER BY COALESCE(i.sale_opportunity, 0) DESC
     LIMIT ?`,
    internalChannel
      ? [internalChannel, now, now - MIN_COLD_MS, now - MAX_COLD_MS, Math.min(limit, dailyCap - sentToday)]
      : [now, now - MIN_COLD_MS, now - MAX_COLD_MS, Math.min(limit, dailyCap - sentToday)],
  );
  if (rows.length === 0) return empty;

  const msgs = new MessagesRepo(db);
  const { model } = createModel(env, "fast", await loadLlmOverrides(env));
  const out = { ...empty };

  for (const cand of rows) {
    // Un lead con 2+ días de frío SIEMPRE está fuera de la ventana de 24h en
    // canales que la tienen — sin plantilla configurada, no hay forma
    // honesta de entregar. No quemamos el claim: puede reengancharse cuando
    // el dueño conecte una plantilla aprobada.
    const plantilla = cand.channel === "whatsapp" ? plantillaReenganche(env) : null;
    const nombrePila = (cand.display_name ?? "").trim().split(/\s+/)[0] ?? "";
    // Sin plantilla, o sin nombre para el saludo de la plantilla, no hay forma honesta de entregar.
    if (WINDOWED.has(cand.channel) && (!plantilla || !nombrePila)) {
      out.skipped++;
      continue;
    }

    // Claim antes de enviar.
    const claim = await db.run(
      "INSERT OR IGNORE INTO reengage_sends (conversation_id, reason, sent_at) VALUES (?, ?, ?)",
      [cand.id, (cand.sale_opportunity ?? 0) === 1 ? "hot" : "keyword", now],
    );
    if ((claim.meta.changes ?? 0) === 0) {
      out.skipped++;
      continue;
    }

    if (plantilla) {
      const tema = temaReenganche(cand.topics);
      const r = await sendYCloudTemplate(env, { to: cand.channel_user_id, name: plantilla.name, language: plantilla.language, bodyParams: [nombrePila, tema] });
      if (r.ok) {
        await msgs.append(cand.id, "assistant", `[Reactivación, plantilla ${plantilla.name}] Hola ${nombrePila}: retomamos ${tema}.`);
        await new ConversationsRepo(db).touchLastMessage(cand.id, now);
        out.sent++;
      } else {
        // El proveedor no la aceptó: se suelta el candado para reintentar otro día.
        await db.run("DELETE FROM reengage_sends WHERE conversation_id = ?", [cand.id]).catch(() => {});
        out.errors++;
        console.warn(`[reengage] plantilla rechazada (${r.reason})`);
      }
      continue;
    }

    try {
      const history = await msgs.lastN(cand.id, 6);
      const transcript = history
        .map((m) => `${m.role === "user" ? "Cliente" : "Tú"}: ${m.content.slice(0, 250)}`)
        .join("\n");
      const result = await generateText({
        model,
        prompt: `Eres ${env.BOT_NAME}, de ${env.BUSINESS_NAME}. Este cliente mostró interés hace unos días y ya no volvió. Escribe UN mensaje muy breve (máx 2 líneas), cálido y natural, sin presión, retomando lo último que hablaron para reactivarlo. ${cand.display_name ? `Se llama ${cand.display_name}.` : ""} Responde SOLO con el mensaje.

Últimos mensajes:
${transcript}`,
      });
      const text = result.text.trim();
      if (!text) throw new Error("empty reengage text");
      await sendOutbound(
        env,
        { conversationId: cand.id, channel: cand.channel as ChannelId, channelUserId: cand.channel_user_id, text },
        now,
      );
      out.sent++;
    } catch (e) {
      out.errors++;
      console.error(`[reengage] failed for ${cand.id}:`, e);
    }
  }

  if (out.sent) console.log(`[reengage] sent=${out.sent} skipped=${out.skipped} errors=${out.errors}`);
  return out;
}
