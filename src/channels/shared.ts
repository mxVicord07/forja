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

// Canales que mandan media NATIVA (foto/audio como archivo) — el resto recibe
// el link en texto (sender.ts), nada se rompe. Adaptado del paquete Forja+
// v1.0.76 (Forja Inbox): ahí la lista incluye "kapso"/"zernio", que no son
// ChannelId válidos en este fork (sin adapters) — se excluyen.
export const MEDIA_CHANNELS: ReadonlySet<ChannelId> = new Set([
  "telegram",
  "whatsapp",
  "twilio",
  "messenger",
  "instagram",
  "manychat",
]);

// Canales que mandan un DOCUMENTO nativo (kind "file"). Instagram y ManyChat
// NO: ahí el archivo va como link en texto — llega igual, sin burbuja bonita.
// Mismo criterio que el paquete original, recortado a nuestros ChannelId.
export const FILE_CHANNELS: ReadonlySet<ChannelId> = new Set([
  "telegram",
  "whatsapp",
  "twilio",
  "messenger",
]);

export interface IncomingMessage {
  channel: ChannelId;
  channelUserId: string;
  /**
   * Id del mensaje del LADO DEL PROVEEDOR (wamid de WhatsApp, mid de Meta,
   * message_id de Telegram). Solo se usa para el indicador de "escribiendo…":
   * WhatsApp (Cloud API y YCloud) exige el id del mensaje entrante para
   * encenderlo — el indicador viaja sobre el mismo endpoint que el acuse de
   * lectura. Los canales que no lo necesitan pueden dejarlo vacío.
   */
  providerMessageId?: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
  receivedAt: number;
  rawPayload: unknown;
}

// Adjunto de un reply — porteado del paquete Forja+ v1.0.76 (superpoder
// Galería + "mandar media desde Forja Inbox"). Campo de tipo SOLAMENTE: hoy
// NINGÚN adapter de este fork lee `media` (ni Galería ni el envío de media
// saliente desde la app están portados — los dos necesitan R2/Bóveda, que
// este bot no tiene provisionado). Se agrega el tipo para que
// src/api-inbox.ts compile; en la práctica es inalcanzable: la única ruta
// que llena `media` está guardada arriba por `if (!c.env.MEDIA)`.
export interface ReplyMedia {
  kind: "image" | "audio" | "video" | "file";
  url: string;
  voice?: boolean;
  caption?: string;
  filename?: string;
}

// Botón tocable (opt-in, ver skill/botones.md). El tap regresa como mensaje de
// texto normal (el título, o en Messenger/Instagram el título vía quick_reply)
// — el cerebro no cambia, solo el formato de salida. `payload` es lo que la
// plataforma devuelve en el tap donde lo soporta (Meta); en Telegram/WhatsApp
// el tap regresa el TÍTULO como si el cliente lo hubiera escrito, no un id.
export interface ReplyButton {
  title: string; // lo que ve el cliente (≤20 chars — límite de WhatsApp)
  payload: string; // id que regresa en el tap donde la plataforma lo soporta
}

// Canales que renderizan botones NATIVOS (WhatsApp botones de respuesta,
// Telegram teclado de una sola vez, Messenger/Instagram quick replies). El
// resto (twilio, manychat) recibe el fallback numerado en texto que arma
// replies/sender.ts — nada se rompe, nadie ve el marcador crudo. Adaptado del
// paquete Forja+ v1.0.76: ahí la lista también incluye "zernio", que no es un
// ChannelId válido en este fork (sin adapter) — se excluye.
export const BUTTON_CHANNELS: ReadonlySet<ChannelId> = new Set([
  "telegram",
  "whatsapp",
  "messenger",
  "instagram",
]);

export interface OutgoingReply {
  channel: ChannelId;
  channelUserId: string;
  chunks: string[];
  interChunkDelayMs?: number;
  // Botones para el ÚLTIMO chunk (máx 3). Solo lo puebla agent.ts cuando el
  // modelo emite el marcador [[botones: …]] (ver replies/sender.ts#extraeBotones)
  // y el canal está en BUTTON_CHANNELS.
  buttons?: ReplyButton[];
  /** Ver ReplyMedia arriba — dormido, ningún adapter lo consume todavía. */
  media?: ReplyMedia[];
}

/**
 * Un documento (PDF, típicamente) que el bot manda además del texto — ver
 * src/tools/shareDocument.ts y src/files/share.ts. `url` es SIEMPRE la URL
 * pública firmada de /files/:id, nunca el r2_key crudo: los proveedores
 * (WhatsApp/Meta) la descargan ellos mismos, Telegram la usa directo.
 */
export interface OutgoingDocument {
  channel: ChannelId;
  channelUserId: string;
  url: string;
  filename: string;
  mimeType: string;
  /** Texto corto junto al archivo. Solo Telegram y WhatsApp lo soportan
   *  (Messenger/Instagram no tienen caption en su Send API) — el adapter que
   *  no lo soporte simplemente lo ignora. */
  caption?: string;
}

/**
 * Contexto para `showTyping`. `providerMessageId` es obligatorio en WhatsApp
 * (ambos proveedores) e ignorado por el resto; sin él, esos adapters no pueden
 * encender el indicador y se saltan la llamada en silencio.
 */
export interface TypingContext {
  /** Canal concreto del hilo. metaAdapter atiende messenger E instagram, que
   *  se envían por hosts y tokens distintos: sin este dato no podría saber
   *  cuál de los dos está atendiendo. */
  channel: ChannelId;
  providerMessageId?: string;
}

export interface ChannelAdapter {
  parseIncoming(request: Request, env: any): Promise<IncomingMessage>;
  sendReply(reply: OutgoingReply, env: any): Promise<void>;
  /**
   * Enciende el indicador nativo de "escribiendo…" del canal. SIEMPRE es
   * best-effort: nunca debe lanzar ni bloquear el envío de la respuesta (ver
   * src/replies/typing.ts, que es quien lo llama). Los canales que no lo
   * soportan (ManyChat, Twilio) simplemente no implementan el método.
   *
   * Cada canal apaga el indicador solo, sin llamada de "typing_off": Telegram
   * a los ~5s, Messenger/Instagram a los ~20s, WhatsApp a los 25s — y en todos,
   * en cuanto llega el mensaje real. Por eso el keepalive lo re-enciende
   * mientras el LLM piensa.
   */
  showTyping?(channelUserId: string, env: any, ctx: TypingContext): Promise<void>;
  /**
   * Manda un documento como archivo adjunto nativo del canal (no un link de
   * texto). Igual que showTyping: SIEMPRE best-effort — el llamador
   * (src/agent.ts) nunca deja que un fallo acá tumbe el turno, porque el
   * texto de la respuesta ya salió antes. Canales sin soporte (ManyChat,
   * Twilio) simplemente no implementan el método.
   */
  sendDocument?(doc: OutgoingDocument, env: any): Promise<void>;
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
