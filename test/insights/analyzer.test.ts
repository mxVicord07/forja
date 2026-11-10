/**
 * Tests for the insights analyzer (the "Analista" layer).
 *
 * Real D1 via miniflare (schema applied by the helper); the LLM layer is fully
 * mocked: `generateText` returns canned grader JSON and the provider module is
 * stubbed so no SDK/network is touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({
    provider: "anthropic",
    modelId: "claude-haiku-test",
    model: { modelId: "claude-haiku-test" },
    supportsPromptCache: true,
  }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { InsightsRepo } from "../../src/db/insights";
import {
  analyzeConversations,
  countPending,
  parseInsightJson,
  IDLE_MS,
} from "../../src/insights/analyzer";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let insights: InsightsRepo;

const GRADE = {
  sentiment: "frustrated",
  resolution: "escalated",
  bot_score: 3,
  topics: ["pagos", "acceso"],
  summary: "El cliente pagó y no recibió acceso; se escaló a un humano.",
  missed_kb: "¿Cuánto tarda la activación después de pagar?",
  sale_opportunity: false,
};

/** A conversation with a real exchange whose last message is IDLE_MS+ old. */
async function seedIdleConversation(userId: string): Promise<string> {
  const conv = await convs.getOrCreate("telegram", userId);
  const old = Date.now() - IDLE_MS - 60_000;
  await msgs.append(conv.id, "user", "Ya pagué y no tengo acceso", { createdAt: old - 2000 });
  await msgs.append(conv.id, "assistant", "Déjame revisar tu pago.", { createdAt: old - 1000 });
  await convs.touchLastMessage(conv.id, old);
  return conv.id;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, ANTHROPIC_API_KEY: "sk-test", BUSINESS_NAME: "Negocio Test" } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  insights = new InsightsRepo(db);
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({ text: JSON.stringify(GRADE) });
});

describe("analyzeConversations", () => {
  it("grades an idle conversation and stores the insight", async () => {
    const convId = await seedIdleConversation("u1");

    const result = await analyzeConversations(env, { limit: 10 });
    expect(result.analyzed).toBe(1);
    expect(result.errors).toBe(0);

    const row = await insights.getByConversation(convId);
    expect(row?.sentiment).toBe("frustrated");
    expect(row?.resolution).toBe("escalated");
    expect(row?.bot_score).toBe(3);
    expect(row?.missed_kb).toContain("activación");

    // The grader received the transcript with role labels in Spanish.
    const call = generateTextMock.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain("Cliente: Ya pagué y no tengo acceso");
    expect(call.prompt).toContain("Bot: Déjame revisar tu pago.");
    expect(call.prompt).toContain("Negocio Test");
  });

  it("con export a Odoo configurado, manda el resumen de cada conversación calificada", async () => {
    const conv = await convs.getOrCreate("whatsapp", "524441796793");
    const old = Date.now() - IDLE_MS - 60_000;
    await msgs.append(conv.id, "user", "¿Cuánto cuesta un asistente?", { createdAt: old - 2000 });
    await msgs.append(conv.id, "owner", "Te escribo yo en un momento", { createdAt: old - 1000 });
    await convs.touchLastMessage(conv.id, old);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await analyzeConversations({ ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.example/upsert" } as Env, { limit: 10 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      kind: "resumen",
      conversationId: conv.id,
      channel: "whatsapp",
      phone: "524441796793",
      summary: GRADE.summary,
      lastMessageAt: new Date(old).toISOString(),
    });
    fetchSpy.mockRestore();
  });

  it("I-052: si el cliente pidió un recordatorio, el resumen lo lleva como recordatorio {fecha, motivo}", async () => {
    const conv = await convs.getOrCreate("whatsapp", "524441796793");
    const old = Date.now() - IDLE_MS - 60_000;
    await msgs.append(conv.id, "user", "Escríbeme el 15 para ver la propuesta", { createdAt: old - 2000 });
    await msgs.append(conv.id, "assistant", "Va, le aviso al equipo.", { createdAt: old - 1000 });
    await convs.touchLastMessage(conv.id, old);
    const futuro = new Date(Date.now() + 5 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ ...GRADE, reminder: { date: futuro, reason: "ver la propuesta" } }) });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await analyzeConversations({ ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.example/upsert" } as Env, { limit: 10 });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.recordatorio).toEqual({ fecha: futuro, motivo: "ver la propuesta" });
    // el prompt le da al modelo el día en que terminó la conversación
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toMatch(/La conversación terminó el \w+ \d{4}-\d{2}-\d{2}/);
    expect(prompt).toContain("reminder");
    fetchSpy.mockRestore();
  });

  it("I-052: un recordatorio con fecha pasada o inválida no viaja en el resumen", async () => {
    const conv = await convs.getOrCreate("whatsapp", "524441796793");
    const old = Date.now() - IDLE_MS - 60_000;
    await msgs.append(conv.id, "user", "Escríbeme el 3", { createdAt: old - 2000 });
    await msgs.append(conv.id, "assistant", "Va.", { createdAt: old - 1000 });
    await convs.touchLastMessage(conv.id, old);
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ ...GRADE, reminder: { date: "2020-01-03", reason: "x" } }) });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await analyzeConversations({ ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.example/upsert" } as Env, { limit: 10 });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("recordatorio");
    fetchSpy.mockRestore();
  });

  it("skips conversations that are still active (not idle)", async () => {
    const conv = await convs.getOrCreate("telegram", "u2");
    await msgs.append(conv.id, "user", "Hola");
    await msgs.append(conv.id, "assistant", "¡Hola!");
    await convs.touchLastMessage(conv.id, Date.now());

    const result = await analyzeConversations(env);
    expect(result.analyzed).toBe(0);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("skips conversations without a real exchange (<2 messages)", async () => {
    const conv = await convs.getOrCreate("telegram", "u3");
    const old = Date.now() - IDLE_MS - 60_000;
    await msgs.append(conv.id, "user", "Hola", { createdAt: old });
    await convs.touchLastMessage(conv.id, old);

    const result = await analyzeConversations(env);
    expect(result.analyzed).toBe(0);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("does not re-grade an already-analyzed conversation, but does when it gets new messages", async () => {
    const convId = await seedIdleConversation("u4");
    await analyzeConversations(env);
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    // No new activity → nothing to do.
    const second = await analyzeConversations(env);
    expect(second.analyzed).toBe(0);
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    // Customer comes back (still idle afterwards) → re-grade.
    const later = Date.now() - IDLE_MS - 1000;
    await msgs.append(convId, "user", "Sigo sin acceso", { createdAt: later });
    await convs.touchLastMessage(convId, later);
    // Force analyzed_at older than the new last_message_at:
    await db.run(
      "UPDATE conversation_insights SET analyzed_at = ? WHERE conversation_id = ?",
      [later - 5000, convId],
    );

    const third = await analyzeConversations(env);
    expect(third.analyzed).toBe(1);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("tolerates fenced/wrapped JSON from the grader", async () => {
    generateTextMock.mockResolvedValue({
      text: "```json\n" + JSON.stringify(GRADE) + "\n```",
    });
    const convId = await seedIdleConversation("u5");

    const result = await analyzeConversations(env);
    expect(result.analyzed).toBe(1);
    expect((await insights.getByConversation(convId))?.sentiment).toBe("frustrated");
  });

  it("counts unparseable grader output as an error and stores nothing", async () => {
    generateTextMock.mockResolvedValue({ text: "no soy json" });
    const convId = await seedIdleConversation("u6");

    const result = await analyzeConversations(env);
    expect(result.analyzed).toBe(0);
    expect(result.errors).toBe(1);
    expect(await insights.getByConversation(convId)).toBeNull();
  });

  it("countPending reflects the queue before and after a run", async () => {
    await seedIdleConversation("u7");
    await seedIdleConversation("u8");
    expect(await countPending(env)).toBe(2);

    await analyzeConversations(env, { limit: 1 });
    expect(await countPending(env)).toBe(1);
  });

  it("con INTERNAL_CHANNEL configurado, ese canal nunca entra a la cola de análisis", async () => {
    // seedIdleConversation ya crea sus conversaciones por "telegram".
    await seedIdleConversation("equipo1");
    const envInternal = { ...env, INTERNAL_CHANNEL: "telegram" } as Env;

    expect(await countPending(envInternal)).toBe(0);
    const result = await analyzeConversations(envInternal);
    expect(result.analyzed).toBe(0);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("INTERNAL_CHANNEL no afecta a otros canales", async () => {
    await convs.getOrCreate("whatsapp", "cliente1");
    const conv = await convs.getOrCreate("whatsapp", "cliente1");
    const old = Date.now() - IDLE_MS - 60_000;
    await msgs.append(conv.id, "user", "Hola", { createdAt: old - 2000 });
    await msgs.append(conv.id, "assistant", "¡Hola!", { createdAt: old - 1000 });
    await convs.touchLastMessage(conv.id, old);

    const envInternal = { ...env, INTERNAL_CHANNEL: "telegram" } as Env;
    expect(await countPending(envInternal)).toBe(1);
  });
});

describe("parseInsightJson", () => {
  it("rejects out-of-range or malformed grades", () => {
    expect(parseInsightJson(JSON.stringify({ ...GRADE, bot_score: 9 }))).toBeNull();
    expect(parseInsightJson(JSON.stringify({ ...GRADE, sentiment: "meh" }))).toBeNull();
    expect(parseInsightJson("{}")).toBeNull();
    expect(parseInsightJson("")).toBeNull();
  });

  it("applies defaults for optional fields", () => {
    const minimal = {
      sentiment: "neutral",
      resolution: "resolved",
      bot_score: 5,
      summary: "Todo bien.",
    };
    const parsed = parseInsightJson(JSON.stringify(minimal));
    expect(parsed?.topics).toEqual([]);
    expect(parsed?.missed_kb).toBeNull();
    expect(parsed?.sale_opportunity).toBe(false);
  });
});

describe("customer facts (flywheel memory)", () => {
  it("stores facts returned by the grader", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        ...GRADE,
        customer_facts: ["Se llama María", "Prefiere pagar en USD"],
      }),
    });
    const convId = await seedIdleConversation("u9");
    await analyzeConversations(env);

    const { CustomerFactsRepo } = await import("../../src/db/facts");
    const facts = await new CustomerFactsRepo(db).forConversation(convId);
    expect(facts.map((f) => f.fact).sort()).toEqual(["Prefiere pagar en USD", "Se llama María"]);

    // Re-analysis doesn't duplicate facts (PK conv+fact).
    await db.run("UPDATE conversation_insights SET analyzed_at = 0 WHERE conversation_id = ?", [convId]);
    await analyzeConversations(env);
    expect(await new CustomerFactsRepo(db).forConversation(convId)).toHaveLength(2);
  });
});
