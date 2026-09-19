import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../../helpers/miniflareSetup";
import { Db } from "../../../src/db/client";
import { ConversationsRepo } from "../../../src/db/conversations";
import { MessagesRepo } from "../../../src/db/messages";
import { collectDailyStats, collectReportContext } from "../../../src/owner/report/collect";
import type { Env } from "../../../src/env";

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  env = { DB: d1, BUSINESS_NAME: "Hugo Hair" } as unknown as Env;
});

describe("collectDailyStats (compat con dailyReport.ts)", () => {
  it("cuenta mensajes de clientes dentro de la ventana de 24h, ignora lo viejo", async () => {
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente");
    await msgs.append(conv.id, "user", "hola", { createdAt: NOW - 1000 });
    await msgs.append(conv.id, "user", "vieja de hace 2 días", { createdAt: NOW - 2 * DAY_MS });
    const stats = await collectDailyStats(env, NOW);
    expect(stats.customerMessages).toBe(1);
  });
});

describe("collectReportContext", () => {
  it("junta stats de hoy y de ayer (prev) por separado", async () => {
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente");
    await msgs.append(conv.id, "user", "hoy", { createdAt: NOW - 1000 });
    await msgs.append(conv.id, "user", "ayer", { createdAt: NOW - DAY_MS - 1000 });

    const ctx = await collectReportContext(env, NOW);
    expect(ctx.stats.customerMessages).toBe(1);
    expect(ctx.prev.customerMessages).toBe(1);
  });

  it("agrupa sentimiento, resolución y rating desde conversation_insights", async () => {
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente");
    await db.run(
      `INSERT INTO conversation_insights (conversation_id, analyzed_at, sentiment, resolution, bot_score, topics, summary, missed_kb, sale_opportunity)
       VALUES (?, ?, 'positive', 'resolved', 5, '["precios","horario"]', 'Preguntó precios', NULL, 0)`,
      [conv.id, NOW - 1000],
    );
    const conv2 = await convs.getOrCreate("telegram", "u2", "Cliente 2");
    await db.run(
      `INSERT INTO conversation_insights (conversation_id, analyzed_at, sentiment, resolution, bot_score, topics, summary, missed_kb, sale_opportunity)
       VALUES (?, ?, 'angry', 'unresolved', 2, '["precios"]', 'Molesto por demora', '¿hacen envíos?', 1)`,
      [conv2.id, NOW - 500],
    );

    const ctx = await collectReportContext(env, NOW);
    expect(ctx.sentiment).toEqual({ contentos: 1, neutrales: 0, frustrados: 0, molestos: 1 });
    expect(ctx.resolutionRate).toBe(50); // 1 de 2 resueltas
    expect(ctx.botRating).toBe(3.5); // (5+2)/2
    expect(ctx.analyzed).toBe(2);
    expect(ctx.topics.map((t) => t.name).sort()).toEqual(["horario", "precios"]);
    expect(ctx.topics.find((t) => t.name === "precios")?.count).toBe(2);
    expect(ctx.missedQuestions).toEqual(["¿hacen envíos?"]);
    expect(ctx.hotLeadSummaries).toEqual(["Molesto por demora"]);
  });

  it("actividad por hora: identifica la hora pico (UTC)", async () => {
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente");
    const at9am = new Date(NOW);
    at9am.setUTCHours(9, 0, 0, 0);
    await msgs.append(conv.id, "user", "a", { createdAt: at9am.getTime() });
    await msgs.append(conv.id, "user", "b", { createdAt: at9am.getTime() });
    await msgs.append(conv.id, "user", "c", { createdAt: at9am.getTime() - 3 * 60 * 60 * 1000 });

    const ctx = await collectReportContext(env, at9am.getTime() + 1000);
    expect(ctx.hourly[9]).toBe(2);
    expect(ctx.peakHour).toBe(9);
  });

  it("sin ninguna actividad: peakHour null, resolutionRate null, botRating null", async () => {
    const ctx = await collectReportContext(env, NOW);
    expect(ctx.peakHour).toBeNull();
    expect(ctx.resolutionRate).toBeNull();
    expect(ctx.botRating).toBeNull();
    expect(ctx.analyzed).toBe(0);
  });

  it("el chat de prueba (canal test) no cuenta en ningún conteo", async () => {
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente real");
    const testConv = await convs.getOrCreate("test", "probando", "Cliente de prueba");
    // getOrCreate usa Date.now() real para started_at — medimos la ventana
    // DESPUÉS de crear ambas conversaciones (mismo motivo que
    // test/owner/dailyReport.test.ts con TicketsRepo.create).
    const now = Date.now() + 1000;
    await msgs.append(conv.id, "user", "real", { createdAt: now - 100 });
    await msgs.append(testConv.id, "user", "prueba", { createdAt: now - 100 });

    const ctx = await collectReportContext(env, now);
    expect(ctx.stats.customerMessages).toBe(1);
    expect(ctx.stats.newConversations).toBe(1);
  });
});
