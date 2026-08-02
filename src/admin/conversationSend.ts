import type { Env } from "../env";
import { Db } from "../db/client";
import { ConversationsRepo } from "../db/conversations";
import { MessagesRepo } from "../db/messages";
import { pickAdapter } from "../replies/sender";
import type { ChannelId } from "../channels/shared";

/**
 * Manda un mensaje al cliente por el canal de su conversación y lo guarda como
 * `role=owner`. Lo comparten la bandeja (responder como humano) y las rutas de
 * aprobación de citas, para no duplicar la secuencia adapter → persistir.
 *
 * Si el envío falla no persiste nada: el cliente nunca recibió el mensaje, y
 * un registro fantasma haría creer al dueño que sí se le avisó.
 */
export async function sendChannelMessage(
  env: Env,
  conversationId: string,
  text: string,
): Promise<{ ok: true; channel: string } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  const convs = new ConversationsRepo(db);
  const conv = await convs.getById(conversationId);
  if (!conv) return { ok: false, error: "Conversación no encontrada." };

  try {
    const adapter = pickAdapter(conv.channel as ChannelId, env);
    await adapter.sendReply(
      {
        channel: conv.channel as ChannelId,
        channelUserId: conv.channel_user_id,
        chunks: [text],
        interChunkDelayMs: 0,
      },
      env,
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  await new MessagesRepo(db).append(conversationId, "owner", text);
  await convs.touchLastMessage(conversationId);
  return { ok: true, channel: conv.channel };
}
