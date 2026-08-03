/**
 * Tests del Reporte diario (superpoder Pro, versión ligera por Telegram):
 *  • junta los números correctos de la ventana de 24h
 *  • tier free → no manda nada
 *  • toggle daily_report apagado (default) → no manda nada
 *  • throttle: no reenvía si ya se mandó hace < 20h
 *  • sin canal de Telegram configurado → no truena, solo no manda
 *  • día vacío → igual manda (confirma que el sistema sigue vivo)
 * fetch mockeado (Telegram); D1 real vía miniflare.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { TicketsRepo } from "../../src/db/tickets";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { collectDailyStats, sendDailyReport } from "../../src/owner/dailyReport";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let settings: SettingsRepo;
let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  settings = new SettingsRepo(db);
  env = {
    DB: d1,
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Hugo Hair",
    BOT_TIER: "pro",
    TELEGRAM_BOT_TOKEN: "tg-test-token",
    OWNER_TELEGRAM_CHAT_ID: "12345",
  } as unknown as Env;
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("collectDailyStats", () => {
  it("cuenta mensajes, leads y tickets dentro de la ventana de 24h — ignora lo viejo", async () => {
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente");
    await msgs.append(conv.id, "user", "hola", { createdAt: NOW - 1000 });
    await msgs.append(conv.id, "user", "otra pregunta", { createdAt: NOW - 2000 });
    await msgs.append(conv.id, "user", "vieja de hace 2 días", { createdAt: NOW - 2 * DAY_MS });

    await db.run(
      "INSERT INTO leads (id, conversation_id, channel_user_id, intent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["lead-1", conv.id, "u1", "compra", NOW - 500, NOW - 500],
    );
    await db.run(
      "INSERT INTO leads (id, conversation_id, channel_user_id, intent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["lead-old", conv.id, "u1", "compra", NOW - 2 * DAY_MS, NOW - 2 * DAY_MS],
    );

    await new TicketsRepo(db).create({
      conversationId: conv.id,
      category: "other",
      summary: "algo",
      transcript: "",
    });

    // TicketsRepo.create usa Date.now() real (no acepta createdAt inyectado),
    // así que medimos la ventana desde DESPUÉS de crearlo — NOW ya quedó atrás.
    const stats = await collectDailyStats(env, Date.now());
    expect(stats.customerMessages).toBe(2);
    expect(stats.newLeads).toBe(1);
    expect(stats.ticketsOpened).toBe(1);
    expect(stats.ticketsResolved).toBe(0);
  });
});

describe("sendDailyReport", () => {
  it("tier free → no manda nada", async () => {
    await settings.set(SETTING_KEYS.dailyReport, "1");
    const r = await sendDailyReport({ ...env, BOT_TIER: "free" } as Env, NOW);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("not_pro");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("toggle apagado (default) → no manda nada", async () => {
    const r = await sendDailyReport(env, NOW);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encendido → manda el resumen por Telegram y guarda la marca de tiempo", async () => {
    await settings.set(SETTING_KEYS.dailyReport, "1");
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente");
    await msgs.append(conv.id, "user", "hola", { createdAt: NOW - 1000 });

    const r = await sendDailyReport(env, NOW);
    expect(r.sent).toBe(true);

    const tgCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.telegram.org"));
    expect(tgCall).toBeTruthy();
    const body = JSON.parse(String(tgCall![1]?.body));
    expect(body.chat_id).toBe("12345");
    expect(body.text).toContain("Hugo Hair");

    expect(await settings.get(SETTING_KEYS.dailyReportLastAt)).toBe(String(NOW));
  });

  it("throttle: no reenvía si ya se mandó hace menos de 20h", async () => {
    await settings.set(SETTING_KEYS.dailyReport, "1");
    await settings.set(SETTING_KEYS.dailyReportLastAt, String(NOW - 5 * 60 * 60 * 1000));

    const r = await sendDailyReport(env, NOW);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("throttled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ya pasaron 20h desde el último → sí reenvía", async () => {
    await settings.set(SETTING_KEYS.dailyReport, "1");
    await settings.set(SETTING_KEYS.dailyReportLastAt, String(NOW - 21 * 60 * 60 * 1000));

    const r = await sendDailyReport(env, NOW);
    expect(r.sent).toBe(true);
  });

  it("día vacío → igual manda (confirma que el sistema sigue vivo)", async () => {
    await settings.set(SETTING_KEYS.dailyReport, "1");
    const r = await sendDailyReport(env, NOW);
    expect(r.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sin canal de Telegram configurado → no truena, no manda", async () => {
    await settings.set(SETTING_KEYS.dailyReport, "1");
    const noChannelEnv = { ...env, TELEGRAM_BOT_TOKEN: undefined, OWNER_TELEGRAM_CHAT_ID: undefined } as Env;
    const r = await sendDailyReport(noChannelEnv, NOW);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("no_channel");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
