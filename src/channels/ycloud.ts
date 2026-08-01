// Canal de WhatsApp vía YCloud (BSP). Alternativa a whatsapp.ts (Cloud API
// directo de Meta) mientras la Verificación de Negocio ante Meta esté
// pendiente. Ambos emiten channel:"whatsapp" a propósito — el Durable Object
// se direcciona con `${channel}:${channelUserId}`, así que compartir el id es
// lo que preserva el historial el día que se migre de un proveedor al otro.
//
// Diferencias contra Meta que este archivo tiene que absorber:
//  • Firma: header propio `YCloud-Signature: t=<unix>,s=<hmac>` sobre
//    `${t}.${body}`, y CON timestamp — así que además se valida antigüedad.
//    No hay handshake GET.
//  • Entrante: un evento = un mensaje (Meta batchea varios por POST).
//  • Media: viene como URL directa, no como media_id, pero su descarga exige
//    X-API-Key — o sea que igual necesita proxy firmado.
//  • Teléfono: E.164 con "+". Se normaliza a dígitos pelones, que es el
//    formato que ya produce whatsapp.ts.
import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import { hmacHex, timingSafeEqual, normalizePhone } from "./shared";
import type { Env } from "../env";

// Re-exportado por compatibilidad: este módulo definía `normalizePhone`
// localmente y hay tests que la importan desde acá. La definición real vive
// en shared.ts (ver comentario ahí) porque whatsapp.ts (Meta Cloud API)
// también la necesita, para producir el mismo `channelUserId` que YCloud.
export { normalizePhone };

/** Ventana anti-replay de la firma entrante. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** TTL de la URL firmada del proxy de media entrante. */
const MEDIA_TTL_MS = 10 * 60 * 1000;

/**
 * Único tipo de evento que representa un mensaje entrante procesable. La
 * documentación de YCloud llama al envelope "whatsappMessage" en algunas
 * páginas, pero el tráfico real (19 muestras capturadas en producción,
 * confirmadas también en el panel de webhooks de YCloud) usa
 * "whatsappInboundMessage" — ver docs/superpowers/specs/ycloud-payloads-capturados.json.
 */
const INBOUND_EVENT = "whatsapp.inbound_message.received";

interface YCloudInboundMessage {
  from?: string;
  id?: string;
  type?: string;
  customerProfile?: { name?: string };
  text?: { body?: string };
  image?: { link?: string; caption?: string; id?: string };
  audio?: { link?: string; id?: string };
}

interface YCloudEvent {
  id?: string;
  type?: string;
  whatsappInboundMessage?: YCloudInboundMessage;
}

/** URL firmada del proxy de media (o null si falta secret/base). */
async function signedMediaUrl(link: string, env: Env, origin: string): Promise<string | null> {
  const secret = env.YCLOUD_WEBHOOK_SECRET;
  const base = (origin || env.DASHBOARD_BASE_URL || "").replace(/\/$/, "");
  if (!secret || !base) return null;
  const exp = Date.now() + MEDIA_TTL_MS;
  const sig = await hmacHex(secret, `${link}.${exp}`);
  return `${base}/webhooks/whatsapp/media?u=${encodeURIComponent(link)}&exp=${exp}&sig=${sig}`;
}

/**
 * Convierte un evento de YCloud en un IncomingMessage, o null si no hay nada
 * que procesar (recibos de entrega, tipos no soportados, evento sin remitente).
 * Devuelve null en vez de lanzar: al mismo endpoint llegan eventos de estado
 * perfectamente normales, y lanzar obligaría a envolver cada llamada en
 * try/catch para no contestarle 500 a YCloud (que reintentaría).
 */
export async function parseYCloudEvent(
  body: unknown,
  env: Env,
  origin: string,
): Promise<IncomingMessage | null> {
  const event = body as YCloudEvent;
  if (event?.type !== INBOUND_EVENT) return null;

  const m = event.whatsappInboundMessage;
  const from = m?.from;
  if (!m || !from) return null;

  let text: string | undefined;
  let audioUrl: string | undefined;
  let imageUrl: string | undefined;

  if (m.type === "text") {
    text = m.text?.body || undefined;
  } else if (m.type === "image" && m.image?.link) {
    // Forma según la documentación de YCloud (image: {link, caption, id}), NO
    // verificada contra un payload real: no hay ninguna muestra de media en
    // las 19 ejecuciones capturadas. Si el primer media real difiere, la
    // fuente de verdad es rawPayload en los logs.
    imageUrl = (await signedMediaUrl(m.image.link, env, origin)) ?? undefined;
    text = m.image.caption || undefined;
  } else if (m.type === "audio" && m.audio?.link) {
    // Igual que arriba: forma solo documentada (audio: {link, id}), no
    // verificada contra tráfico real. Ver rawPayload en los logs cuando
    // llegue el primer audio real para confirmar/corregir esta forma.
    audioUrl = (await signedMediaUrl(m.audio.link, env, origin)) ?? undefined;
  }

  console.log(
    "ycloud in:",
    JSON.stringify({ type: m.type, hasText: !!text, hasAudio: !!audioUrl, hasImage: !!imageUrl }),
  );
  if (!text && !audioUrl && !imageUrl) return null;

  return {
    channel: "whatsapp",
    channelUserId: normalizePhone(from),
    displayName: m.customerProfile?.name,
    text,
    audioUrl,
    imageUrl,
    isOwnerMessage: false,
    receivedAt: Date.now(),
    rawPayload: event,
  };
}

/**
 * Verifica el header `YCloud-Signature: t=<unix_segundos>,s=<hmac_hex>`, donde
 * el HMAC-SHA256 se calcula sobre `${t}.${raw}`.
 *
 * A diferencia de Meta, la firma incluye timestamp: se valida que esté dentro
 * de la ventana en AMBAS direcciones (un reloj adelantado no debe abrir la
 * puerta). Fail-closed ante cualquier duda. `now` es inyectable para tests.
 */
export async function verifyYCloudSignature(
  raw: string,
  header: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!header || !secret) return false;

  let t: string | undefined;
  let s: string | undefined;
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") t = v?.trim();
    else if (k?.trim() === "s") s = v?.trim();
  }
  if (!t || !s) return false;

  const tSeconds = Number(t);
  if (!Number.isFinite(tSeconds)) return false;
  if (Math.abs(now - tSeconds * 1000) > SIGNATURE_TOLERANCE_MS) return false;

  const expected = await hmacHex(secret, `${t}.${raw}`);
  return timingSafeEqual(expected, s);
}

/** Único host del que el proxy acepta descargar. */
const YCLOUD_MEDIA_HOST = "api.ycloud.com";

/**
 * Sirve el media entrante de YCloud: valida firma + expiración + host, y
 * descarga con la API key del lado del server. Público pero firmado — la key
 * nunca sale. Lo usa GET /webhooks/whatsapp/media (ver index.ts).
 *
 * A diferencia del proxy de Meta, aquí se firma una URL y no un media_id
 * opaco. Por eso se valida además que el host sea api.ycloud.com: sin ese
 * chequeo, quien obtuviera el secret podría convertir el Worker en un SSRF
 * que descarga cualquier URL de internet.
 */
export async function serveYCloudMedia(
  u: string | null,
  exp: string | null,
  sig: string | null,
  env: Env,
): Promise<Response> {
  const secret = env.YCLOUD_WEBHOOK_SECRET;
  const apiKey = env.YCLOUD_API_KEY;
  if (!secret || !apiKey) return new Response("not configured", { status: 404 });

  const expNum = Number(exp);
  if (!u || !exp || !sig || !Number.isFinite(expNum)) {
    return new Response("bad request", { status: 400 });
  }
  if (Date.now() > expNum) return new Response("expired", { status: 410 });

  const expected = await hmacHex(secret, `${u}.${exp}`);
  if (!timingSafeEqual(expected, sig)) return new Response("bad signature", { status: 403 });

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  // `.host` (no `.hostname`) para que un puerto explícito distinto también
  // rebote — mismo host "de verdad" con :9999 no debería colarse.
  if (parsed.host !== YCLOUD_MEDIA_HOST) return new Response("host not allowed", { status: 403 });
  // Solo https: el hostname correcto con otro esquema (ftp:, blob:) pasaría la
  // allowlist de host y haría explotar el fetch en vez de devolver un código
  // determinístico.
  if (parsed.protocol !== "https:") return new Response("scheme not allowed", { status: 403 });

  let res: Response;
  try {
    // redirect: "manual" — la allowlist de host solo protege el primer salto.
    // Con "follow" (el default), el X-API-Key se reenviaría tal cual a
    // cualquier destino de un 3xx (a diferencia de Authorization, que algunos
    // clientes sí despojan cross-origin), rompiendo la promesa de que la key
    // nunca sale del servidor. Si YCloud alguna vez redirige a un CDN, hay
    // que seguir el Location con un segundo fetch SIN el header.
    res = await fetch(u, { headers: { "X-API-Key": apiKey }, redirect: "manual" });
  } catch {
    // fetch lanza TypeError ante fallo de DNS, TLS o conexión cortada. El
    // contrato de este proxy es no explotar nunca — se traduce a 502.
    return new Response("media download failed", { status: 502 });
  }
  if (!res.ok) return new Response("media download failed", { status: 502 });
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return new Response(res.body, { status: 200, headers: { "Content-Type": contentType } });
}

const SEND_URL = "https://api.ycloud.com/v2/whatsapp/messages";

export const ycloudAdapter: ChannelAdapter = {
  // Existe por la interfaz ChannelAdapter; el webhook usa parseYCloudEvent
  // directamente, porque puede devolver null (eventos de estado) y la
  // interfaz obliga a devolver un IncomingMessage.
  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage> {
    const body = await request.json();
    const origin = new URL(request.url).origin;
    const msg = await parseYCloudEvent(body, env, origin);
    if (!msg) throw new Error("evento de YCloud sin mensaje procesable");
    return msg;
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const apiKey = env.YCLOUD_API_KEY;
    const from = env.YCLOUD_WA_FROM;
    if (!apiKey || !from) {
      throw new Error("YCloud: falta YCLOUD_API_KEY o YCLOUD_WA_FROM.");
    }
    // Internamente el teléfono viaja sin "+", pero YCloud exige E.164.
    const to = `+${normalizePhone(reply.channelUserId)}`;
    for (let i = 0; i < reply.chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await fetch(SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({
          from,
          to,
          type: "text",
          text: { body: reply.chunks[i], preview_url: false },
        }),
      });
      // Fuera de la ventana de 24h Meta rechaza texto libre (pide plantilla
      // HSM). No lo tragues en silencio, pero tampoco tumbes el turno. Sin
      // PII: el teléfono destino no va en el log (commit 1934d25).
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`ycloud sendReply ${res.status}: ${errBody}`);
      }
    }
  },
};
