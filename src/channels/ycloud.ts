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
import { hmacHex, timingSafeEqual } from "./shared";
import type { Env } from "../env";

/** Ventana anti-replay de la firma entrante. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

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
