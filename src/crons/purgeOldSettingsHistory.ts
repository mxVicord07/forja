import type { Env } from "../env";
import { Db } from "../db/client";

/** settings_history rows older than this are purged by the daily cron. */
export const SETTINGS_HISTORY_RETENTION_DAYS = 365;

/**
 * Daily cron: delete settings_history rows older than the retention window.
 * `settings` itself (current values) is never touched.
 *
 * `now` is injectable for tests; defaults to the current time.
 */
export async function purgeOldSettingsHistory(env: Env, now: number = Date.now()): Promise<number> {
  const cutoff = now - SETTINGS_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const db = new Db(env.DB);
  const res = await db.run("DELETE FROM settings_history WHERE changed_at < ?", [cutoff]);
  const deleted = res.meta.changes ?? 0;
  console.log(`[cron purgeOldSettingsHistory] deleted ${deleted} rows older than ${SETTINGS_HISTORY_RETENTION_DAYS}d`);
  return deleted;
}
