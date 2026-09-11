// Canal OFICIAL de Meta (sin ManyChat): Facebook Messenger + Instagram DMs.
//
// Una sola app de Meta cubre ambos. El webhook (Messenger e Instagram) trae el
// MISMO formato — entry[].messaging[] con sender/message — así que este único
// adaptador sirve para los dos. El envío es la Send API de Meta
// (graph.facebook.com/.../me/messages) con el Page Access Token.
//
// El webhook necesita 2 cosas que ManyChat ocultaba:
//  • GET de verificación (handshake con META_VERIFY_TOKEN) — lo maneja index.ts.
//  • Validar la firma X-Hub-Signature-256 de cada POST — verifyMetaSignature().
import type { ChannelAdapter, IncomingMessage, OutgoingReply, OutgoingDocument, ChannelId, TypingContext } from "./shared";
import type { Env } from "../env";
import { egressFetch } from "../http/egress";
import { stripMarkdown } from "../replies/chunker";

const GRAPH_VERSION = "v21.0";

interface MetaMessaging {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: { type: string; payload?: { url?: string } }[];
  };
}

interface MetaWebhookBody {
  object?: string;
  entry?: { id?: string; time?: number; messaging?: MetaMessaging[] }[];
}

/**
 * Convierte un webhook de Meta en 0..N mensajes entrantes. Un solo POST puede
 * traer varias entradas y varios eventos; también trae echoes (mensajes que la
 * propia página envió) y recibos de entrega/lectura, que se ignoran.
 */
export function parseMetaEvents(body: MetaWebhookBody): IncomingMessage[] {
  const channel: ChannelId = body.object === "instagram" ? "instagram" : "messenger";
  const out: IncomingMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      // Log SIN datos personales: nunca el texto del cliente ni su id completo
      // (los últimos 4 dígitos bastan para correlacionar un evento en los logs).
      console.log("meta in:", JSON.stringify({
        ch: channel,
        sender: ev.sender?.id ? `…${String(ev.sender.id).slice(-4)}` : undefined,
        echo: m?.is_echo,
        kind: m?.text ? "text" : m?.attachments?.[0]?.type ?? "other",
      }));
      if (!m || m.is_echo) continue; // ignora echoes
      if (m.quick_reply) continue; // tap de botón (quick reply), no es texto para el LLM
      const sender = ev.sender?.id;
      if (!sender) continue;
      const audio = m.attachments?.find((a) => a.type === "audio");
      const image = m.attachments?.find((a) => a.type === "image");
      if (!m.text && !audio && !image) continue; // ignora recibos/postbacks sin contenido
      out.push({
        channel,
        channelUserId: String(sender),
        providerMessageId: m.mid,
        text: m.text || undefined,
        audioUrl: audio?.payload?.url,
        imageUrl: image?.payload?.url,
        isOwnerMessage: false,
        receivedAt: Date.now(),
        rawPayload: ev,
      });
    }
  }
  return out;
}

/**
 * Valida la firma HMAC-SHA256 (`X-Hub-Signature-256: sha256=<hex>`) que Meta
 * pone en cada POST, usando el App Secret. Comparación en tiempo constante.
 * Fail-closed: sin firma válida o sin secret → false.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!appSecret || !signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// El token de Instagram Login resuelve `me` al "app-scoped id", que NO es el
// dueño del hilo de mensajes — ese es el `user_id` (el Instagram Business
// Account ID). Enviar como `me` da error "not the thread owner" (subcode
// 2534037). Resolvemos el user_id una vez y lo cacheamos por token.
let igSenderIdCache: { token: string; id: string } | null = null;
async function instagramSenderId(token: string): Promise<string> {
  if (igSenderIdCache?.token === token) return igSenderIdCache.id;
  try {
    const r = await egressFetch(
      `https://graph.instagram.com/${GRAPH_VERSION}/me?fields=user_id&access_token=${encodeURIComponent(token)}`,
    );
    const j = (await r.json()) as { user_id?: string | number };
    const id = j?.user_id ? String(j.user_id) : "me";
    igSenderIdCache = { token, id };
    return id;
  } catch {
    return "me";
  }
}

/**
 * Resuelve a DÓNDE y con QUÉ token se le habla a este hilo. Dos rutas según
 * cómo se conectó Instagram:
 *  • "Instagram API con Instagram Login" (token IGAA…) → graph.instagram.com
 *    + INSTAGRAM_ACCESS_TOKEN.
 *  • Messenger / IG ligado a una Página de Facebook → graph.facebook.com
 *    + META_PAGE_ACCESS_TOKEN.
 * Messenger envía como `me` (la Página). Instagram Login debe enviar como el
 * user_id (dueño del hilo), no como `me` (app-scoped id) → si no, 2534037.
 *
 * Vive fuera de sendReply porque el indicador de "escribiendo…" (sender
 * actions) pega al MISMO endpoint: si cada uno resolviera el destino por su
 * cuenta, podrían discrepar y los puntitos saldrían por una ruta y el mensaje
 * por otra.
 */
async function resolveSendTarget(
  channel: ChannelId,
  env: Env,
): Promise<{ url: string; token: string; useIG: boolean; node: string }> {
  const useIG = channel === "instagram" && !!env.INSTAGRAM_ACCESS_TOKEN;
  const base = useIG ? "https://graph.instagram.com" : "https://graph.facebook.com";
  const token = useIG ? env.INSTAGRAM_ACCESS_TOKEN : env.META_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Meta: falta INSTAGRAM_ACCESS_TOKEN (IG Login) o META_PAGE_ACCESS_TOKEN (Messenger).");
  }
  const node = useIG ? await instagramSenderId(token) : "me";
  return { url: `${base}/${GRAPH_VERSION}/${node}/messages`, token, useIG, node };
}

export const metaAdapter: ChannelAdapter = {
  // Existe por la interfaz ChannelAdapter; el webhook /webhooks/meta usa
  // parseMetaEvents directamente (un POST puede traer varios mensajes).
  async parseIncoming(request: Request, _env: Env): Promise<IncomingMessage> {
    const body = (await request.json()) as MetaWebhookBody;
    const [first] = parseMetaEvents(body);
    if (!first) throw new Error("meta webhook sin mensaje procesable");
    return first;
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const { url, token, useIG, node } = await resolveSendTarget(reply.channel, env);
    console.log("meta out:", JSON.stringify({ useIG, node, to: reply.channelUserId }));
    for (let i = 0; i < reply.chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const payload: Record<string, unknown> = {
        recipient: { id: reply.channelUserId },
        // Messenger/Instagram no renderizan marcado: se aplana (si no, el
        // cliente ve los asteriscos crudos).
        message: { text: stripMarkdown(reply.chunks[i]) },
      };
      if (!useIG) payload.messaging_type = "RESPONSE"; // requerido en Messenger, no en IG Login
      const res = await egressFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      // Meta responde 200 con el message_id o un error JSON. No lo tragues: si
      // falla, logéalo con el cuerpo para ver el motivo exacto (permiso, ventana
      // de 24h, recipiente inválido, etc.).
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`meta sendReply ${res.status} ${useIG ? "IG" : "FB"}: ${errBody}`);
      }
    }
  },

  /**
   * "Escribiendo…" de Messenger e Instagram: sender actions de la Send API.
   * Manda `mark_seen` (visto) y luego `typing_on` — dos POST separados porque
   * Meta exige que el cuerpo traiga SOLO `recipient` + `sender_action`, nada
   * más. No hace falta `typing_off`: el indicador se apaga solo al llegar la
   * respuesta (o a los ~20s).
   * https://developers.facebook.com/docs/messenger-platform/send-messages/sender-actions
   *
   * En Instagram Login (graph.instagram.com) Meta documenta sender actions
   * sobre el host de Graph; si esa ruta rechazara la acción, el warning queda
   * en el log y el mensaje sale igual — nunca se bloquea el envío.
   */
  async showTyping(channelUserId: string, env: Env, ctx: TypingContext): Promise<void> {
    const { url, token, useIG } = await resolveSendTarget(ctx.channel, env);
    for (const action of ["mark_seen", "typing_on"] as const) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ recipient: { id: channelUserId }, sender_action: action }),
      });
      if (!res.ok) {
        console.warn(
          `meta showTyping(${action}) ${res.status} ${useIG ? "IG" : "FB"}: ${await res.text().catch(() => "")}`,
        );
      }
    }
  },

  /**
   * Adjunto tipo "file" vía URL: Meta lo descarga ella misma. La Send API no
   * tiene un campo de caption para archivos — el texto ya salió antes como
   * mensaje aparte (agent.ts manda el texto y LUEGO el documento).
   * https://developers.facebook.com/docs/messenger-platform/send-messages#file_attachment
   */
  async sendDocument(doc: OutgoingDocument, env: Env): Promise<void> {
    const { url, token, useIG } = await resolveSendTarget(doc.channel, env);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recipient: { id: doc.channelUserId },
        message: { attachment: { type: "file", payload: { url: doc.url, is_reusable: true } } },
      }),
    });
    if (!res.ok) {
      console.warn(`meta sendDocument ${res.status} ${useIG ? "IG" : "FB"}: ${await res.text().catch(() => "")}`);
    }
  },
};
