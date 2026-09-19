import type { ChannelAdapter, ChannelId, ReplyButton } from "../channels/shared";
import { BUTTON_CHANNELS } from "../channels/shared";
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

// ── Botones (opt-in, ver skill/botones.md) ───────────────────────────────────
// El modelo puede terminar su respuesta con el marcador
//   [[botones: Sí, agendar | Ver precios | Otra duda]]
// (se le enseña en el prompt SOLO si buttons_enabled está prendido — ver
// system-prompt.ts — pero el parser SIEMPRE lo honra, así un prompt override
// también puede usarlo). Máx 3 opciones, títulos a 20 chars (límite de
// WhatsApp). Porteado de Forja+ v1.0.76, sin cambios: es texto puro, no toca
// nada específico de este fork.
const MARCADOR_RE = /\[\[\s*(?:botones|buttons)\s*:\s*([^\]]+)\]\]/gi;

export function extraeBotones(chunks: string[]): { chunks: string[]; buttons?: ReplyButton[] } {
  let buttons: ReplyButton[] | undefined;
  const limpios = chunks
    .map((c) => {
      let out = c;
      for (const m of c.matchAll(MARCADOR_RE)) {
        // Si el modelo mandara dos marcadores, el último gana.
        const titulos = m[1]
          .split("|")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 3);
        if (titulos.length) {
          buttons = titulos.map((t) => ({ title: t.slice(0, 20), payload: `btn:${t.slice(0, 40)}` }));
        }
        out = out.replace(m[0], "");
      }
      return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    })
    .filter((c) => c.length > 0);
  return { chunks: limpios, buttons };
}

/** Fallback en texto para canales sin botones nativos (twilio, manychat). */
export function botonesATexto(buttons: ReplyButton[]): string {
  return buttons.map((b, i) => `${i + 1}) ${b.title}`).join("\n");
}

/**
 * Decide botones nativos vs. fallback numerado según soporte del canal.
 * Único lugar que conoce BUTTON_CHANNELS — agent.ts y sendChunkedReply lo
 * llaman después de extraeBotones() para no duplicar esta decisión.
 */
export function resolveButtonsForChannel(
  channel: ChannelId,
  chunks: string[],
  buttons: ReplyButton[] | undefined,
): { chunks: string[]; buttons?: ReplyButton[] } {
  if (!buttons?.length) return { chunks };
  if (!BUTTON_CHANNELS.has(channel)) {
    const lista = botonesATexto(buttons);
    const finales = chunks.length
      ? [...chunks.slice(0, -1), `${chunks[chunks.length - 1]}\n\n${lista}`]
      : [lista];
    return { chunks: finales };
  }
  // El modelo mandó SOLO el marcador: los botones necesitan un cuerpo de texto.
  const finales = chunks.length ? chunks : [buttons.map((b) => b.title).join(" · ")];
  return { chunks: finales, buttons };
}

export async function sendChunkedReply(
  adapter: ChannelAdapter,
  channel: ChannelId,
  channelUserId: string,
  chunks: string[],
  env: Env,
  interChunkDelayMs?: number,
): Promise<void> {
  const ext = extraeBotones(chunks);
  const { chunks: finales, buttons } = resolveButtonsForChannel(channel, ext.chunks, ext.buttons);
  if (!finales.length) return;
  // Default to a human-like, length-proportional pause between chunks.
  const delay =
    interChunkDelayMs ??
    (finales.length > 1 ? chunkDelayMs(finales[0]) : undefined);
  await adapter.sendReply(
    { channel, channelUserId, chunks: finales, interChunkDelayMs: delay, buttons },
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
 * Única función que interpreta WA_PROVIDER — la usan tanto el webhook de
 * ENTRADA (src/index.ts) como el resolver de SALIDA de acá abajo. Si cada
 * lado normalizara distinto (mayúsculas, espacios), un mensaje podría entrar
 * por un proveedor y la respuesta intentar salir por el otro: el bot
 * recibiría el mensaje y jamás contestaría. Default "meta": no altera a quien
 * ya opera con Cloud API directo. Un valor no reconocido (typo) cae a Meta
 * igual, pero lo registra — degradarse en silencio por una variable mal
 * escrita es peor que ser ruidoso, y lanzar tumbaría el turno completo.
 */
export function resolveWaProvider(env: Env): "ycloud" | "meta" {
  const provider = (env.WA_PROVIDER ?? "meta").trim().toLowerCase();
  if (provider === "ycloud") return "ycloud";
  if (provider !== "meta") {
    console.error(`WA_PROVIDER no reconocido: ${provider} — usando "meta".`);
  }
  return "meta";
}

function pickWhatsAppAdapter(env: Env): ChannelAdapter {
  return resolveWaProvider(env) === "ycloud" ? ycloudAdapter : whatsappAdapter;
}
