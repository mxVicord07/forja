const DEFAULT_MAX_CHUNKS = 3;

/**
 * Aplana el Markdown a texto legible: para los canales que NO renderizan
 * ningún marcado (Messenger/Instagram, ManyChat, widget web — que pinta con
 * textContent), donde un `**texto**` crudo le llega tal cual al cliente.
 *
 * OJO — no se aplica en `chunkReply`, a propósito. Upstream lo puso ahí como
 * red de seguridad global partiendo de que "ningún canal renderiza Markdown",
 * pero eso no es exacto: Telegram (legacy Markdown) y WhatsApp SÍ renderizan
 * negrita, solo que con *un* asterisco. Por eso cada adapter decide: Telegram
 * usa toTelegramMarkdown(), WhatsApp/YCloud/Twilio usan toWhatsAppMarkdown(),
 * y los canales sin marcado usan esta función. Sanear en el embudo mataría la
 * negrita real que ya está verificada en producción en Telegram y WhatsApp.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/(\*\*|__)([^\n]+?)\1/g, "$2") // **negrita** / __negrita__ → negrita
    .replace(/`([^`\n]+)`/g, "$1") //          `código` → código
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") //     # Encabezado → sin marcador
    .replace(/^[ \t]*[-*]\s+/gm, "• "); //     viñeta "- " / "* " → "• "
}

export function chunkReply(text: string, maxChunks: number = DEFAULT_MAX_CHUNKS): string[] {
  const cap = Math.max(1, Math.floor(maxChunks));
  const trimmed = text.trim();

  if (cap === 1) return [trimmed];

  // Try paragraph split first (explicit breaks win over length)
  const paras = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length > 1 && paras.length <= cap) {
    return paras;
  }
  if (paras.length > cap) {
    // Keep the first cap-1 paragraphs, merge the tail into the last chunk
    const head = paras.slice(0, cap - 1);
    const tail = paras.slice(cap - 1).join(" ");
    return [...head, tail];
  }

  // Single paragraph — try sentence split
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 1) return [trimmed];

  // Distribute sentences into <= cap groups
  const chunks: string[] = [];
  const perChunk = Math.ceil(sentences.length / cap);
  for (let i = 0; i < sentences.length; i += perChunk) {
    chunks.push(sentences.slice(i, i + perChunk).join(" "));
  }
  return chunks.slice(0, cap);
}
