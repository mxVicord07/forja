import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { SettingsRepo } from "../../src/db/settings";
import {
  type LearnedMapping,
  saveLearnedMapping,
  loadLearnedMapping,
  saveCapture,
  loadCapture,
  isLearnMode,
  startLearnMode,
  stopLearnMode,
  isLearnModeEnabled,
} from "../../src/learn/mapping";

let repo: SettingsRepo;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  repo = new SettingsRepo(db);
});

describe("learned mapping persistence", () => {
  it("loadLearnedMapping returns null when nothing is saved", async () => {
    expect(await loadLearnedMapping(repo, "instagram")).toBeNull();
  });

  it("round-trips a full mapping", async () => {
    const mapping: LearnedMapping = {
      idPath: "body.id",
      textPath: "last_input_text",
      audioPath: "attachments.0.payload.url",
      imagePath: "attachments.0.payload.url",
      channelPath: "last_growth_tool.channel",
      sendType: "instagram",
    };
    await saveLearnedMapping(repo, "instagram", mapping);
    expect(await loadLearnedMapping(repo, "instagram")).toEqual(mapping);
  });

  it("round-trips a partial mapping (optional fields absent)", async () => {
    const mapping: LearnedMapping = { idPath: "body.id", textPath: "text" };
    await saveLearnedMapping(repo, "whatsapp", mapping);
    expect(await loadLearnedMapping(repo, "whatsapp")).toEqual(mapping);
  });

  it("keeps mappings isolated per channel", async () => {
    await saveLearnedMapping(repo, "instagram", { idPath: "ig.id" });
    await saveLearnedMapping(repo, "messenger", { idPath: "fb.id" });
    expect(await loadLearnedMapping(repo, "instagram")).toEqual({
      idPath: "ig.id",
    });
    expect(await loadLearnedMapping(repo, "messenger")).toEqual({
      idPath: "fb.id",
    });
  });

  it("save overwrites the previous mapping for the same channel", async () => {
    await saveLearnedMapping(repo, "instagram", { idPath: "old.id" });
    await saveLearnedMapping(repo, "instagram", { idPath: "new.id" });
    expect(await loadLearnedMapping(repo, "instagram")).toEqual({
      idPath: "new.id",
    });
  });
});

describe("capture persistence", () => {
  it("loadCapture returns null when nothing is captured", async () => {
    expect(await loadCapture(repo, "instagram", "audio")).toBeNull();
  });

  it("round-trips a raw payload by channel + kind", async () => {
    const payload = {
      body: { id: "123" },
      attachments: [{ type: "audio", payload: { url: "https://x/a.mp3" } }],
    };
    await saveCapture(repo, "instagram", "audio", payload);
    expect(await loadCapture(repo, "instagram", "audio")).toEqual(payload);
  });

  it("keeps captures isolated per channel and per kind", async () => {
    await saveCapture(repo, "instagram", "audio", { k: "ig-audio" });
    await saveCapture(repo, "instagram", "image", { k: "ig-image" });
    await saveCapture(repo, "whatsapp", "audio", { k: "wa-audio" });

    expect(await loadCapture(repo, "instagram", "audio")).toEqual({
      k: "ig-audio",
    });
    expect(await loadCapture(repo, "instagram", "image")).toEqual({
      k: "ig-image",
    });
    expect(await loadCapture(repo, "whatsapp", "audio")).toEqual({
      k: "wa-audio",
    });
  });

  it("preserves nested arrays/objects through the round-trip", async () => {
    const payload = { a: [1, { b: ["c", null] }], d: "text" };
    await saveCapture(repo, "custom", "text", payload);
    expect(await loadCapture(repo, "custom", "text")).toEqual(payload);
  });
});

describe("learn mode (auto-expiration by injected timestamp)", () => {
  it("is off by default (no until stored)", async () => {
    expect(await isLearnMode(repo, "instagram", 1_000)).toBe(false);
  });

  it("isLearnMode is true while now < until, false once now > until", async () => {
    const start = 1_000_000;
    // 15-minute default window = 900_000 ms
    await startLearnMode(repo, "instagram", 15, start);

    // before expiration
    expect(await isLearnMode(repo, "instagram", start + 1)).toBe(true);
    expect(await isLearnMode(repo, "instagram", start + 899_999)).toBe(true);
    // exactly at expiration is NOT in learn mode (until > now must be strict)
    expect(await isLearnMode(repo, "instagram", start + 900_000)).toBe(false);
    // after expiration
    expect(await isLearnMode(repo, "instagram", start + 900_001)).toBe(false);
  });

  it("startLearnMode honors a custom duration in minutes", async () => {
    const start = 5_000;
    await startLearnMode(repo, "whatsapp", 1, start); // 1 minute = 60_000 ms
    expect(await isLearnMode(repo, "whatsapp", start + 59_999)).toBe(true);
    expect(await isLearnMode(repo, "whatsapp", start + 60_000)).toBe(false);
  });

  it("stopLearnMode turns it off immediately", async () => {
    const start = 1_000_000;
    await startLearnMode(repo, "instagram", 15, start);
    expect(await isLearnMode(repo, "instagram", start + 1)).toBe(true);

    await stopLearnMode(repo, "instagram");
    expect(await isLearnMode(repo, "instagram", start + 1)).toBe(false);
  });

  it("learn mode is isolated per channel", async () => {
    const start = 1_000_000;
    await startLearnMode(repo, "instagram", 15, start);
    expect(await isLearnMode(repo, "instagram", start + 1)).toBe(true);
    expect(await isLearnMode(repo, "messenger", start + 1)).toBe(false);
  });

  it("startLearnMode/stopLearnMode attribute to the passed actor in settings_history", async () => {
    const start = 1_000_000;
    await startLearnMode(repo, "instagram", 15, start, "owner");
    await stopLearnMode(repo, "instagram", "owner");

    const rows = await db.all<{ actor: string }>(
      "SELECT actor FROM settings_history WHERE key = 'learn:instagram:until' ORDER BY changed_at ASC",
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.actor === "owner")).toBe(true);
  });

  it("startLearnMode/stopLearnMode default to 'system' when no actor is passed", async () => {
    const start = 2_000_000;
    await startLearnMode(repo, "whatsapp", 15, start);

    const rows = await db.all<{ actor: string }>(
      "SELECT actor FROM settings_history WHERE key = 'learn:whatsapp:until'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.actor === "system")).toBe(true);
  });
});

describe("isLearnModeEnabled (gate global, apagado por defecto)", () => {
  it("apagado cuando la var no está seteada", () => {
    expect(isLearnModeEnabled({})).toBe(false);
  });

  it("apagado con undefined explícito", () => {
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: undefined })).toBe(false);
  });

  it("prendido con \"1\"", () => {
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: "1" })).toBe(true);
  });

  it("prendido con \"true\" en cualquier capitalización y con espacios", () => {
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: "true" })).toBe(true);
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: "TRUE" })).toBe(true);
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: " TRUE " })).toBe(true);
  });

  it("prendido con \"1\" con espacios alrededor", () => {
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: " 1 " })).toBe(true);
  });

  it("apagado con valores raros: \"0\", \"yes\", string vacío", () => {
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: "0" })).toBe(false);
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: "yes" })).toBe(false);
    expect(isLearnModeEnabled({ LEARN_MODE_ENABLED: "" })).toBe(false);
  });
});
