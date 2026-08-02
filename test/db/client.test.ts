import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";

let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
});

describe("Db client", () => {
  it("instantiates with a D1 binding", async () => {
    expect(db).toBeDefined();
  });
});

describe("Db.batch", () => {
  it("runs multiple statements atomically", async () => {
    await db.batch([
      { sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", params: ["a", "1", 100] },
      { sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", params: ["b", "2", 100] },
    ]);
    const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM settings ORDER BY key");
    expect(rows).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  });

  it("supports statements with no params", async () => {
    await db.batch([
      { sql: "INSERT INTO settings (key, value, updated_at) VALUES ('x', 'y', 1)" },
    ]);
    expect(await db.first<{ value: string }>("SELECT value FROM settings WHERE key = 'x'")).toEqual({ value: "y" });
  });
});
