/**
 * Tests de Reactivación de leads fríos (runReengage): segundo toque a leads
 * calientes que se enfriaron 2-7 días. Entrega honesta por canal: Telegram
 * (sin ventana de 24h, siempre puede escribir libre) sí reengancha; los
 * canales con ventana (WhatsApp/Twilio/ManyChat/Messenger) SIEMPRE están
 * fuera de ventana a los 2+ días, así que se saltan SIN quemar el claim —
 * no hay plantilla HSM configurada en este bot, y nunca se inventa un envío
 * que el proveedor rechazaría.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const sendReplyMock = vi.fn();

vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }));
vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({ provider: "anthropic", modelId: "m", model: {}, supportsPromptCache: true }),
}));
vi.mock("../../src/replies/sender", () => ({
  pickAdapter: () => ({ sendReply: (...a: unknown[]) => sendReplyMock(...a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { InsightsRepo } from "../../src/db/insights";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { runReengage } from "../../src/followup/reengage";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let insights: InsightsRepo;
let settings: SettingsRepo;

const NOW = Date.now();
const COLD = NOW - 4 * 24 * 60 * 60 * 1000; // 4 días atrás: dentro de 2-7 días

async function seedHot(userId: string, channel: string, userAt = COLD): Promise<string> {
  const conv = await convs.getOrCreate(channel, userId, `Lead ${userId}`);
  await msgs.append(conv.id, "user", "me interesa", { createdAt: userAt - 1000 });
  await msgs.append(conv.id, "assistant", "claro, te cuento", { createdAt: userAt + 500 });
  await convs.touchLastMessage(conv.id, userAt + 500);
  await insights.upsert({
    conversationId: conv.id,
    sentiment: "positive",
    resolution: "unresolved",
    botScore: 4,
    topics: [],
    summary: "interesado",
    missedKb: null,
    saleOpportunity: true,
  });
  return conv.id;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "Santi",
    BUSINESS_NAME: "Horizontes IA",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
  } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  insights = new InsightsRepo(db);
  settings = new SettingsRepo(db);
  generateTextMock.mockReset().mockResolvedValue({ text: "¡Hola! ¿Seguimos con lo que hablamos?" });
  sendReplyMock.mockReset().mockResolvedValue(undefined);
  await settings.set(SETTING_KEYS.reengageColdLeads, "1");
});

it("no hace nada si el toggle está apagado", async () => {
  await settings.set(SETTING_KEYS.reengageColdLeads, "0");
  await seedHot("a", "telegram");
  const r = await runReengage(env, { now: NOW });
  expect(r).toEqual({ sent: 0, skipped: 0, errors: 0 });
});

it("respeta free tier (no Pro → no manda)", async () => {
  await seedHot("a", "telegram");
  const r = await runReengage({ ...env, BOT_TIER: "free" } as Env, { now: NOW });
  expect(r).toEqual({ sent: 0, skipped: 0, errors: 0 });
});

it("reengancha un lead frío en Telegram (free-form out-of-window)", async () => {
  await seedHot("a", "telegram");
  const r = await runReengage(env, { now: NOW });
  expect(r.sent).toBe(1);
  expect(sendReplyMock).toHaveBeenCalledTimes(1);
});

it("en WhatsApp fuera de ventana → skip, no quema el claim (sin plantilla configurada)", async () => {
  await seedHot("a", "twilio");
  const r = await runReengage(env, { now: NOW });
  expect(r.sent).toBe(0);
  expect(r.skipped).toBe(1);
  expect(sendReplyMock).not.toHaveBeenCalled();
  const row = await db.first<{ n: number }>("SELECT COUNT(*) n FROM reengage_sends", []);
  expect(row?.n).toBe(0);
});

it("claim único: no reengancha dos veces la misma conversación", async () => {
  await seedHot("a", "telegram");
  await runReengage(env, { now: NOW });
  sendReplyMock.mockClear();
  const r2 = await runReengage(env, { now: NOW + 1000 });
  expect(r2.sent).toBe(0);
  expect(sendReplyMock).not.toHaveBeenCalled();
});

it("no toca leads tibios (sin sale_opportunity ni keyword)", async () => {
  const conv = await convs.getOrCreate("telegram", "tibio", "Tibio");
  await msgs.append(conv.id, "user", "hola", { createdAt: COLD - 1000 });
  await msgs.append(conv.id, "assistant", "hola!", { createdAt: COLD });
  await convs.touchLastMessage(conv.id, COLD);
  const r = await runReengage(env, { now: NOW });
  expect(r.sent).toBe(0);
});

it("sí toca leads fríos con solo keyword_hits (sin sale_opportunity)", async () => {
  const conv = await convs.getOrCreate("telegram", "kw1", "Kw");
  await msgs.append(conv.id, "user", "quiero info", { createdAt: COLD - 1000 });
  await msgs.append(conv.id, "assistant", "claro", { createdAt: COLD });
  await convs.touchLastMessage(conv.id, COLD);
  await db.run(
    "INSERT INTO keyword_hits (keyword, conversation_id, phase, created_at) VALUES (?, ?, ?, ?)",
    ["QUIERO", conv.id, "interes", COLD],
  );
  const r = await runReengage(env, { now: NOW });
  expect(r.sent).toBe(1);
});
