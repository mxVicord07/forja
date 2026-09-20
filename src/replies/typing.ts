// Indicador nativo de "escribiendo…" (los tres puntitos) por canal.
//
// Por qué existe este módulo y no vive dentro de cada adapter: el indicador se
// apaga solo (Telegram ~5s, Messenger/Instagram ~20s, WhatsApp 25s) y el bot
// tarda MÁS que eso en contestar — buffer de mensajes (3-30s configurables) +
// el turno del LLM. Sin re-encenderlo, el cliente ve los puntitos un momento y
// luego un silencio largo, que es peor que no mostrarlos. Acá vive esa política
// (cada cuánto refrescar, cuánto tiempo máximo) en un solo lugar, y la garantía
// de que NADA de esto puede tumbar un envío: es puro adorno, siempre fail-open.
import type { ChannelAdapter, ChannelId, TypingContext } from "../channels/shared";
import type { Env } from "../env";

/**
 * Cada cuánto re-encender el indicador, por canal — un poco antes de que el
 * proveedor lo apague solo. 0 = el canal no lo soporta (ManyChat expone el
 * "typing" solo en su Flow Builder, no en la API de envío; Twilio no lo expone
 * para WhatsApp fuera de su beta).
 */
const REFRESH_MS: Record<ChannelId, number> = {
  telegram: 4000,
  messenger: 15000,
  instagram: 15000,
  whatsapp: 20000,
  manychat: 0,
  twilio: 0,
  web: 0, // sin proveedor — el navegador hace polling, no hay "typing" que encender
};

/**
 * Tope duro del keepalive. Si el LLM se cuelga más que esto, dejamos de
 * mentirle al cliente con puntitos eternos — a esa altura el indicador ya no
 * comunica "ahí voy" sino que algo se rompió.
 */
const MAX_KEEPALIVE_MS = 90_000;

/** ¿Este canal + adapter pueden mostrar el indicador? */
export function supportsTyping(adapter: ChannelAdapter, channel: ChannelId): boolean {
  return typeof adapter.showTyping === "function" && REFRESH_MS[channel] > 0;
}

/**
 * Enciende el indicador una vez. Nunca lanza: cualquier fallo (token vencido,
 * ventana de 24h, id de mensaje viejo) se registra y se sigue de largo — el
 * cliente prefiere una respuesta sin puntitos que ninguna respuesta.
 */
export async function showTypingSafe(
  adapter: ChannelAdapter,
  channel: ChannelId,
  channelUserId: string,
  env: Env,
  providerMessageId?: string,
): Promise<void> {
  if (!supportsTyping(adapter, channel)) return;
  try {
    const ctx: TypingContext = { channel, providerMessageId };
    await adapter.showTyping!(channelUserId, env, ctx);
  } catch (e) {
    console.warn(`[typing] ${channel} falló (se ignora):`, e);
  }
}

/**
 * Enciende el indicador y lo mantiene vivo hasta que se llame al `stop()` que
 * devuelve (o hasta MAX_KEEPALIVE_MS). Úsalo alrededor del turno del LLM:
 *
 *   const stop = startTypingKeepalive(...);
 *   try { ...LLM... } finally { stop(); }
 *
 * El `finally` importa: si el turno truena, el keepalive tiene que morir igual
 * o sigue latiendo dentro del Durable Object.
 */
export function startTypingKeepalive(
  adapter: ChannelAdapter,
  channel: ChannelId,
  channelUserId: string,
  env: Env,
  providerMessageId?: string,
): () => void {
  if (!supportsTyping(adapter, channel)) return () => {};

  let stopped = false;
  const startedAt = Date.now();
  // Primer disparo inmediato, sin await: el llamador no debe esperar al
  // proveedor para empezar a pensar la respuesta.
  void showTypingSafe(adapter, channel, channelUserId, env, providerMessageId);

  const timer = setInterval(() => {
    if (stopped || Date.now() - startedAt > MAX_KEEPALIVE_MS) {
      clearInterval(timer);
      return;
    }
    void showTypingSafe(adapter, channel, channelUserId, env, providerMessageId);
  }, REFRESH_MS[channel]);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
