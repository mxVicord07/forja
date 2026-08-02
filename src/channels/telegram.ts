import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import type { Env } from "../env";

const TG_API = "https://api.telegram.org/bot";

/**
 * The model writes CommonMark (`**bold**`, `*italic*` — what "Markdown OK" in
 * the system prompt means to an LLM). Telegram's legacy `parse_mode:
 * "Markdown"` uses a DIFFERENT, non-standard mapping: a single `*text*` is
 * BOLD (not italic), and italic is `_text_`. Sending CommonMark as-is means
 * `**text**` is just literal asterisks to Telegram (never an error — it just
 * doesn't match legacy Markdown's single-asterisk-bold rule), and any
 * `*text*` the model meant as italic would silently render bold instead.
 * This normalizes CommonMark to Telegram's legacy dialect before sending.
 */
export function toTelegramMarkdown(text: string): string {
  const SENTINEL = "\x01";
  return text
    .replace(/\*\*(.+?)\*\*/gs, SENTINEL + "$1" + SENTINEL)
    .replace(/\*(.+?)\*/gs, "_$1_")
    .split(SENTINEL)
    .map((part, i) => (i % 2 === 1 ? "*" + part + "*" : part))
    .join("");
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name?: string; is_bot: boolean };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    caption?: string;
    voice?: { file_id: string; duration: number };
    photo?: { file_id: string; width: number; height: number }[];
  };
}

export async function resolveTelegramFileUrl(
  fileId: string,
  token: string,
): Promise<string | null> {
  // Telegram files are NOT directly addressable by file_id. You must call
  // getFile to obtain a file_path, then download from
  // https://api.telegram.org/file/bot<token>/<file_path> (per Bot API docs).
  const res = await fetch(`${TG_API}${token}/getFile?file_id=${fileId}`);
  if (!res.ok) return null;
  const json: any = await res.json();
  if (!json?.ok) return null;
  return `https://api.telegram.org/file/bot${token}/${json.result.file_path}`;
}

export const telegramAdapter: ChannelAdapter = {
  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage> {
    const update = (await request.json()) as TgUpdate;
    const msg = update.message;
    if (!msg) throw new Error("not a message update");
    const channelUserId = String(msg.from.id);
    const displayName = msg.from.first_name;
    let text = msg.text;
    let audioUrl: string | undefined;
    let imageUrl: string | undefined;
    const token = env.TELEGRAM_BOT_TOKEN ?? "";
    if (msg.voice) {
      // Resolve to a real, fetchable HTTPS URL via getFile (see docs above).
      audioUrl = (await resolveTelegramFileUrl(msg.voice.file_id, token)) ?? undefined;
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      imageUrl = (await resolveTelegramFileUrl(largest.file_id, token)) ?? undefined;
      text = msg.caption;
    }
    return {
      channel: "telegram",
      channelUserId,
      displayName,
      text,
      audioUrl,
      imageUrl,
      // The owner intervenes from their own Telegram account: detect by matching
      // the sender against OWNER_TELEGRAM_CHAT_ID (the same id used for handoff DMs).
      isOwnerMessage:
        env.OWNER_TELEGRAM_CHAT_ID != null &&
        channelUserId === String(env.OWNER_TELEGRAM_CHAT_ID),
      receivedAt: Date.now(),
      rawPayload: update,
    };
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    for (let i = 0; i < reply.chunks.length; i++) {
      // typing indicator (best effort)
      await fetch(`${TG_API}${token}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: reply.channelUserId, action: "typing" }),
      }).catch(() => {});
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      // parse_mode "Markdown" so the model's **bold**/`code` renders instead of
      // showing literal asterisks/backticks. Legacy mode (not MarkdownV2) is
      // intentional: MarkdownV2 requires escaping ~12 special chars in plain
      // prose, which the model doesn't do. The model writes CommonMark
      // (**bold**), but Telegram's legacy Markdown uses a single *asterisk*
      // for bold and _underscore_ for italic — toTelegramMarkdown() converts
      // between the two dialects first. If a chunk still has an unmatched
      // entity, Telegram rejects the whole call — fall back to plain text so
      // a formatting glitch never drops a message outright.
      const res = await fetch(`${TG_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: reply.channelUserId,
          text: toTelegramMarkdown(reply.chunks[i]),
          parse_mode: "Markdown",
        }),
      });
      if (!res.ok) {
        console.warn(
          `[telegram] parse_mode=Markdown rejected (${res.status}), falling back to plain text: ${await res.text()}`,
        );
        await fetch(`${TG_API}${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: reply.channelUserId, text: reply.chunks[i] }),
        });
      }
    }
  },

  async showTyping(channelUserId: string, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    await fetch(`${TG_API}${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelUserId, action: "typing" }),
    }).catch(() => {});
  },
};
