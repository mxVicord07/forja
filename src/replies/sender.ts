import type { ChannelAdapter, ChannelId } from "../channels/shared";
import type { Env } from "../env";
import { telegramAdapter } from "../channels/telegram";
import { manychatAdapter } from "../channels/manychat";
import { twilioAdapter } from "../channels/twilio";
import { metaAdapter } from "../channels/meta";
import { whatsappAdapter } from "../channels/whatsapp";
import { ycloudAdapter } from "../channels/ycloud";

const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 1500;
const MS_PER_CHAR = 30;

// Human-like inter-chunk delay: proportional to chunk length (~30ms/char),
// clamped to [800, 1500]ms so replies feel typed, not dumped.
export function chunkDelayMs(chunk: string): number {
  const proportional = chunk.length * MS_PER_CHAR;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, proportional));
}

export async function sendChunkedReply(
  adapter: ChannelAdapter,
  channel: ChannelId,
  channelUserId: string,
  chunks: string[],
  env: Env,
  interChunkDelayMs?: number,
): Promise<void> {
  // Default to a human-like, length-proportional pause between chunks.
  const delay =
    interChunkDelayMs ??
    (chunks.length > 1 ? chunkDelayMs(chunks[0]) : undefined);
  await adapter.sendReply(
    { channel, channelUserId, chunks, interChunkDelayMs: delay },
    env,
  );
}

/**
 * Resuelve el adapter de SALIDA. Recibe `env` porque el canal "whatsapp" tiene
 * dos proveedores posibles (Cloud API directo de Meta y YCloud como BSP) que
 * comparten channel id a propósito — ver src/channels/ycloud.ts. Sin `env`,
 * la entrada podría venir por YCloud y la salida irse por Meta: el bot
 * recibiría el mensaje y nunca contestaría.
 */
export function pickAdapter(channel: ChannelId, env: Env): ChannelAdapter {
  if (channel === "telegram") return telegramAdapter;
  if (channel === "manychat") return manychatAdapter;
  if (channel === "twilio") return twilioAdapter;
  if (channel === "whatsapp") return pickWhatsAppAdapter(env);
  if (channel === "messenger" || channel === "instagram") return metaAdapter;
  throw new Error(`unknown channel: ${channel}`);
}

/**
 * Default "meta": no altera a quien ya opera con Cloud API directo. Un valor
 * no reconocido (typo) cae a Meta igual, pero lo registra — degradarse en
 * silencio por una variable mal escrita es peor que ser ruidoso, y lanzar
 * tumbaría el turno completo.
 */
function pickWhatsAppAdapter(env: Env): ChannelAdapter {
  const provider = env.WA_PROVIDER ?? "meta";
  if (provider === "ycloud") return ycloudAdapter;
  if (provider !== "meta") {
    console.error(`WA_PROVIDER no reconocido: ${provider} — usando "meta".`);
  }
  return whatsappAdapter;
}
