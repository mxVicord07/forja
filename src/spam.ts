// Guardrail anti-spam determinístico — corre ANTES del LLM, así el spam no
// cuesta ni un token. Si el mensaje entrante es idéntico (normalizado) a 2+ de
// los últimos 5 mensajes del usuario EN LA VENTANA RECIENTE (SPAM_WINDOW_MS —
// es decir, va por la 3ª vez EN POCO TIEMPO), la conversación se manda "a
// descansar": paused_until = ahora + 1 hora y el bot la ignora por completo.
// El caso abusivo-pero-variado (insultos, bots que varían el texto) lo cubre
// la tool snoozeUser, que decide el LLM.
//
// La ventana de tiempo existe porque sin ella, una despedida habitual como
// "Gracias" repetida a lo largo de DÍAS distintos (cerrar cada conversación
// así, no flood) contaba igual que 3 mensajes idénticos en segundos — pausaba
// al cliente por una hora sin ningún error visible. Incidente real:
// 2026-08-11, conversación whatsapp:524441796793.
import { Db } from "./db/client";

export const SPAM_SNOOZE_MS = 60 * 60_000;

const SPAM_LOOKBACK = 5;
// El entrante + 2 iguales previos = 3ª repetición → cooldown.
const SPAM_REPEATS = 2;
// Solo cuentan repeticiones dentro de esta ventana — flood real es cuestión de
// minutos, no un mismo cierre de conversación reaparecido días después.
const SPAM_WINDOW_MS = 15 * 60_000;

/** "  ¡HOLA!! " → "¡hola!!" no — quita acentos/espacios extra y baja a minúsculas. */
export function normalizeForSpam(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function isRepeatSpam(
  db: Db,
  conversationId: string,
  text: string,
  now = Date.now(),
): Promise<boolean> {
  const norm = normalizeForSpam(text);
  if (norm.length < 2) return false; // "ok"/"sí" sueltos no cuentan como spam
  const rows = await db.all<{ content: string }>(
    `SELECT content FROM messages
     WHERE conversation_id = ? AND role = 'user' AND created_at > ?
     ORDER BY created_at DESC LIMIT ?`,
    [conversationId, now - SPAM_WINDOW_MS, SPAM_LOOKBACK],
  );
  const same = rows.filter((r) => normalizeForSpam(r.content) === norm).length;
  return same >= SPAM_REPEATS;
}

// ── Tope diario de turnos (backstop anti "ChatGPT gratis") ──────────────────
// El caso fino (preguntas fuera de tema) lo decide el LLM con snoozeUser; este
// tope es el respaldo determinístico de costos: nadie legítimo cruza 50 turnos
// de usuario en 24h (cada turno ya viene agrupado por el buffer). Al cruzarlo,
// UNA despedida amable y la conversación descansa 12 horas.

export const DAILY_TURN_CAP = 50;
export const DAILY_CAP_SNOOZE_MS = 12 * 3600_000;
export const DAILY_CAP_MESSAGE =
  "¡Gracias por escribir tanto! Por hoy ya te acompañé un buen rato; si necesitas algo más, con gusto seguimos mañana. 🙌";

export async function isOverDailyCap(
  db: Db,
  conversationId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) as n FROM messages
     WHERE conversation_id = ? AND role = 'user' AND created_at > ?`,
    [conversationId, now - 24 * 3600_000],
  );
  return (row?.n ?? 0) >= DAILY_TURN_CAP;
}
