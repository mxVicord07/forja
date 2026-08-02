export type ChannelId = "manychat" | "telegram" | "twilio" | "messenger" | "instagram" | "whatsapp";

// El union de arriba es solo de tipos — no existe en runtime. Esta constante
// es la lista real para validar un `:channel` que llega como string (params
// de ruta, body, etc.) contra los valores válidos.
//
// `satisfies Record<ChannelId, 1>` obliga a que el objeto tenga una key por
// cada miembro del union: si mañana se agrega un canal a ChannelId y se
// olvida acá, tsc falla en vez de dejar que ese canal quede huérfano
// (aceptado por el tipo pero rechazado en runtime con 400).
const CHANNEL_ID_SET = {
  manychat: 1,
  telegram: 1,
  twilio: 1,
  messenger: 1,
  instagram: 1,
  whatsapp: 1,
} satisfies Record<ChannelId, 1>;
export const CHANNEL_IDS: readonly ChannelId[] = Object.keys(CHANNEL_ID_SET) as ChannelId[];

/** Type guard en runtime: ¿`value` es uno de los ChannelId válidos? */
export function isChannelId(value: string): value is ChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(value);
}

export interface IncomingMessage {
  channel: ChannelId;
  channelUserId: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
  receivedAt: number;
  rawPayload: unknown;
}

export interface OutgoingReply {
  channel: ChannelId;
  channelUserId: string;
  chunks: string[];
  interChunkDelayMs?: number;
}

export interface ChannelAdapter {
  parseIncoming(request: Request, env: any): Promise<IncomingMessage>;
  sendReply(reply: OutgoingReply, env: any): Promise<void>;
  showTyping?(channelUserId: string, env: any): Promise<void>;
}

/**
 * HMAC-SHA256 en hex. Compartido por los adapters que verifican firmas de
 * webhook y firman URLs de proxy de media (WhatsApp Cloud y YCloud).
 */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparación en tiempo constante: no filtra el contenido por timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Formato canónico interno del teléfono para `channelUserId`: solo dígitos.
 * TODOS los adapters de WhatsApp (YCloud y Meta Cloud API) deben pasar el
 * `from` entrante por acá antes de usarlo como `channelUserId`. Ambos emiten
 * `channel:"whatsapp"` a propósito — el Durable Object se direcciona
 * `whatsapp:<channelUserId>` y la conversación en D1 se busca por
 * (channel, channelUserId) — para que el historial sobreviva el día que se
 * migre de YCloud a Cloud API directo. Si cada proveedor normalizara el
 * teléfono a su manera (YCloud entrega E.164 con "+", Meta sin él), esa
 * garantía se rompe y cada cliente arrancaría de cero tras la migración.
 */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * El modelo escribe CommonMark (`**bold**`, lo que "Markdown OK" en el
 * system prompt significa para un LLM). WhatsApp usa su propio dialecto:
 * un solo `*bold*` es negrita, `_italic_` es cursiva — `**` no es nada
 * especial, sale como asteriscos literales. Sin esta conversión el cliente
 * ve `**BIRevX**` tal cual en vez de negrita. Comparte la misma estrategia
 * que `toTelegramMarkdown` (Telegram legacy Markdown usa el mismo dialecto
 * de bold-con-un-asterisco), pero vive acá porque la usan ambos adapters de
 * WhatsApp (YCloud y Meta Cloud API).
 */
export function toWhatsAppMarkdown(text: string): string {
  const SENTINEL = "\x01";
  return text
    .replace(/\*\*(.+?)\*\*/gs, SENTINEL + "$1" + SENTINEL)
    .replace(/\*(.+?)\*/gs, "_$1_")
    .split(SENTINEL)
    .map((part, i) => (i % 2 === 1 ? "*" + part + "*" : part))
    .join("");
}
