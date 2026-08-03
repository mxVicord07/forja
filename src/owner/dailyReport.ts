/**
 * Reporte diario (superpoder Pro) — resumen de texto al dueño por Telegram.
 *
 * Versión ligera a propósito: sin insights redactados por IA, sin PDF/DOCX,
 * sin correo (Resend no está conectado en este bot) y sin página nueva en el
 * panel. Solo los números que ya vive el dueño preguntándose cada mañana:
 * mensajes de clientes, leads nuevos, leads calientes, tickets abiertos y
 * resueltos, clientes molestos — todo de tablas que YA existen (leads,
 * tickets, messages, conversation_insights).
 *
 * Corre en el cron diario (0 3 * * *, ver src/index.ts). Guardas: solo Pro +
 * toggle daily_report (default OFF — mandar un mensaje no pedido es opt-in);
 * idempotente vía throttle de 20h; best-effort (una falla no tira los otros
 * crons ni deja el sistema sin canal de aviso).
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo, SETTING_KEYS } from "../db/settings";
import { isPro } from "../config";

const DAY_MS = 24 * 60 * 60 * 1000;
/** No reenviar si ya se mandó hace menos de esto (protege del doble tick del cron). */
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

export interface ReportStats {
  customerMessages: number;
  newLeads: number;
  hotLeads: number;
  ticketsOpened: number;
  ticketsResolved: number;
  upsetCustomers: number;
}

async function count(db: Db, sql: string, since: number, until: number): Promise<number> {
  return (await db.first<{ n: number }>(sql, [since, until]))?.n ?? 0;
}

/** Números de las últimas 24h (ventana [now - DAY_MS, now]). */
export async function collectDailyStats(env: Env, now: number): Promise<ReportStats> {
  const db = new Db(env.DB);
  const since = now - DAY_MS;
  const [customerMessages, newLeads, hotLeads, ticketsOpened, ticketsResolved, upsetCustomers] =
    await Promise.all([
      count(db, "SELECT COUNT(*) AS n FROM messages WHERE created_at > ? AND created_at <= ? AND role = 'user'", since, now),
      count(db, "SELECT COUNT(*) AS n FROM leads WHERE created_at > ? AND created_at <= ?", since, now),
      count(
        db,
        "SELECT COUNT(*) AS n FROM conversation_insights WHERE analyzed_at > ? AND analyzed_at <= ? AND sale_opportunity = 1",
        since,
        now,
      ),
      count(db, "SELECT COUNT(*) AS n FROM tickets WHERE created_at > ? AND created_at <= ?", since, now),
      count(db, "SELECT COUNT(*) AS n FROM tickets WHERE resolved_at > ? AND resolved_at <= ?", since, now),
      count(
        db,
        "SELECT COUNT(*) AS n FROM conversation_insights WHERE analyzed_at > ? AND analyzed_at <= ? AND sentiment IN ('angry','frustrated')",
        since,
        now,
      ),
    ]);
  return { customerMessages, newLeads, hotLeads, ticketsOpened, ticketsResolved, upsetCustomers };
}

function dateLabel(now: number): string {
  try {
    return new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long" }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function formatReportText(businessName: string, now: number, s: ReportStats): string {
  const lines = [
    `📊 Resumen de ${businessName} — ${dateLabel(now)}`,
    "",
    `💬 ${s.customerMessages} mensajes de clientes`,
    `🧲 ${s.newLeads} leads nuevos${s.hotLeads > 0 ? ` (${s.hotLeads} calientes 🔥)` : ""}`,
    `🎫 ${s.ticketsOpened} tickets abiertos, ${s.ticketsResolved} resueltos`,
  ];
  if (s.upsetCustomers > 0) {
    lines.push(`⚠️ ${s.upsetCustomers} cliente(s) molesto(s) — revisa tu bandeja`);
  }
  if (s.customerMessages === 0 && s.newLeads === 0) {
    lines.push("", "Día tranquilo — sin mensajes de clientes.");
  }
  return lines.join("\n");
}

export interface DailyReportResult {
  sent: boolean;
  reason?: "not_pro" | "disabled" | "throttled" | "no_channel";
  stats?: ReportStats;
}

/**
 * Punto de entrada del cron diario. Nunca lanza — cualquier falla del envío
 * queda en logs, nunca tumba los demás trabajos nocturnos que corren junto.
 */
export async function sendDailyReport(env: Env, now: number = Date.now()): Promise<DailyReportResult> {
  if (!isPro(env)) return { sent: false, reason: "not_pro" };

  const settings = new SettingsRepo(new Db(env.DB));
  if ((await settings.get(SETTING_KEYS.dailyReport)) !== "1") {
    return { sent: false, reason: "disabled" };
  }

  const last = Number.parseInt((await settings.get(SETTING_KEYS.dailyReportLastAt)) ?? "0", 10) || 0;
  if (now - last < MIN_GAP_MS) return { sent: false, reason: "throttled" };

  if (!env.TELEGRAM_BOT_TOKEN || !env.OWNER_TELEGRAM_CHAT_ID) {
    console.error(
      "[dailyReport] sin OWNER_TELEGRAM_CHAT_ID configurado — el dueño no verá su reporte diario",
    );
    return { sent: false, reason: "no_channel" };
  }

  const stats = await collectDailyStats(env, now);
  const text = formatReportText(env.BUSINESS_NAME, now, stats);

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.OWNER_TELEGRAM_CHAT_ID, text }),
    });
  } catch (e) {
    console.error("[dailyReport] telegram failed:", e);
  }

  await settings.set(SETTING_KEYS.dailyReportLastAt, String(now));
  return { sent: true, stats };
}
