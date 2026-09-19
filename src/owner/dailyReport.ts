/**
 * Reporte diario (superpoder Pro) — aviso al dueño por Telegram.
 *
 * Reusa el motor de Reportes diseñados (owner/report/*, skill /reportes):
 * los mismos datos ricos (tendencia, sentimiento, temas, calificación del
 * bot) y los mismos insights que escribe la IA, en la versión de TEXTO
 * (Telegram no renderiza HTML) — con un link a la página con gráficas
 * (/admin/report). Antes esta función tenía su propia recolección de datos
 * más simple (solo conteos, sin IA); collectDailyStats se conserva acá como
 * re-export por compatibilidad con callers/tests que ya la importaban de
 * este módulo.
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
import { buildReport, reportSnapshot, type ReportSnapshot } from "./report/build";

export { collectDailyStats, type ReportStats } from "./report/collect";

const MIN_GAP_MS = 20 * 60 * 60 * 1000; // no reenviar si ya se mandó hace menos de esto

export interface DailyReportResult {
  sent: boolean;
  reason?: "not_pro" | "disabled" | "throttled" | "no_channel";
  snapshot?: ReportSnapshot;
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

  const report = await buildReport(env, now);

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.OWNER_TELEGRAM_CHAT_ID, text: report.text }),
    });
  } catch (e) {
    console.error("[dailyReport] telegram failed:", e);
  }

  const snapshot = reportSnapshot(report, now);
  // Guardado para GET /api/report/latest (Forja Inbox) — así la app no paga
  // otra llamada de IA solo por consultar el reporte de hoy.
  await settings.set(SETTING_KEYS.reportLastJson, JSON.stringify(snapshot));
  await settings.set(SETTING_KEYS.dailyReportLastAt, String(now));
  return { sent: true, snapshot };
}
