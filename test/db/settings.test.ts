import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";

let repo: SettingsRepo;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  repo = new SettingsRepo(db);
});

describe("SettingsRepo", () => {
  it("get returns null for an unset key", async () => {
    expect(await repo.get(SETTING_KEYS.tone)).toBeNull();
  });

  it("set then get round-trips a value", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    expect(await repo.get(SETTING_KEYS.botName)).toBe("Pelusa");
  });

  it("set upserts (second set overwrites, no duplicate row)", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido y cercano");
    await repo.set(SETTING_KEYS.tone, "formal y profesional");
    expect(await repo.get(SETTING_KEYS.tone)).toBe("formal y profesional");
    const all = await repo.all();
    // exactly one key present
    expect(Object.keys(all)).toEqual([SETTING_KEYS.tone]);
  });

  it("all returns a Record of every stored key/value", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    await repo.set(SETTING_KEYS.bufferSeconds, "5");
    await repo.set(SETTING_KEYS.botPaused, "1");
    const all = await repo.all();
    expect(all).toEqual({
      [SETTING_KEYS.botName]: "Pelusa",
      [SETTING_KEYS.bufferSeconds]: "5",
      [SETTING_KEYS.botPaused]: "1",
    });
  });

  it("all returns an empty object when nothing is set", async () => {
    expect(await repo.all()).toEqual({});
  });

  it("does not write a history row when the value is unchanged", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido y cercano");
    await repo.set(SETTING_KEYS.tone, "cálido y cercano");
    const history = await db.all<{ key: string }>("SELECT key FROM settings_history");
    expect(history).toHaveLength(1);
  });

  it("writes a history row with old_value NULL on the first write of a key", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    const rows = await db.all<{ key: string; old_value: string | null; new_value: string; actor: string }>(
      "SELECT key, old_value, new_value, actor FROM settings_history",
    );
    expect(rows).toEqual([
      { key: SETTING_KEYS.botName, old_value: null, new_value: "Pelusa", actor: "system" },
    ]);
  });

  it("records old_value on a subsequent change", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido y cercano");
    await repo.set(SETTING_KEYS.tone, "formal y profesional");
    const rows = await db.all<{ old_value: string | null; new_value: string }>(
      "SELECT old_value, new_value FROM settings_history ORDER BY id",
    );
    expect(rows).toEqual([
      { old_value: null, new_value: "cálido y cercano" },
      { old_value: "cálido y cercano", new_value: "formal y profesional" },
    ]);
  });

  it("defaults actor to 'system' when not passed", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    const row = await db.first<{ actor: string }>("SELECT actor FROM settings_history LIMIT 1");
    expect(row?.actor).toBe("system");
  });

  it("records the actor when passed explicitly", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido", "owner");
    const row = await db.first<{ actor: string }>("SELECT actor FROM settings_history LIMIT 1");
    expect(row?.actor).toBe("owner");
  });
});
