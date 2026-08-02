import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { purgeOldSettingsHistory, SETTINGS_HISTORY_RETENTION_DAYS } from "../../src/crons/purgeOldSettingsHistory";

let env: any;
let db: Db;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = { DB: d1 };
  db = new Db(d1 as any);
});

async function insertAged(key: string, changedAt: number) {
  await db.run(
    `INSERT INTO settings_history (key, old_value, new_value, actor, changed_at) VALUES (?, NULL, 'x', 'system', ?)`,
    [key, changedAt],
  );
}

describe("purgeOldSettingsHistory cron", () => {
  it("deletes history rows older than the retention window but keeps recent ones", async () => {
    const now = 1_000 * DAY;
    await insertAged("old-1", now - (SETTINGS_HISTORY_RETENTION_DAYS + 5) * DAY);
    await insertAged("old-2", now - (SETTINGS_HISTORY_RETENTION_DAYS + 1) * DAY);
    await insertAged("recent", now - 3 * DAY);

    const deleted = await purgeOldSettingsHistory(env, now);
    expect(deleted).toBe(2);

    const remaining = await db.all<{ key: string }>("SELECT key FROM settings_history");
    expect(remaining).toEqual([{ key: "recent" }]);
  });

  it("deletes nothing when all rows are within the window", async () => {
    const now = 1_000 * DAY;
    await insertAged("a", now - 1 * DAY);
    const deleted = await purgeOldSettingsHistory(env, now);
    expect(deleted).toBe(0);
  });
});
