import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { sendPaymentLinkTool } from "../../src/tools/cobros";
import { Db } from "../../src/db/client";
import type { Env } from "../../src/env";

let d1: any;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  db = new Db(d1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendPaymentLinkTool", () => {
  it("error payments_not_connected sin STRIPE_SECRET_KEY (no toca fetch ni D1)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = sendPaymentLinkTool({ DB: d1 } as unknown as Env, () => "conv-1");
    const res = (await tool.execute!({ amount: 100, currency: "mxn", description: "Cobro" }, {} as any)) as any;
    expect(res).toEqual({ error: "payments_not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("genera el link, guarda el payment_intent en centavos, y lo devuelve", async () => {
    await db.run(
      `INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at)
       VALUES ('conv-1', 'telegram', 'u1', ?, ?)`,
      [Date.now(), Date.now()],
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "price_1" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "plink_1", url: "https://buy.stripe.com/x" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const env = { DB: d1, STRIPE_SECRET_KEY: "sk_test_x" } as unknown as Env;
    const tool = sendPaymentLinkTool(env, () => "conv-1");
    const res = (await tool.execute!(
      { amount: 250, currency: "mxn", description: "Corte + barba" },
      {} as any,
    )) as any;

    expect(res).toEqual({ url: "https://buy.stripe.com/x", amount: 250, currency: "mxn", description: "Corte + barba" });

    const row = await db.first<{ amount: number; currency: string; status: string; conversation_id: string }>(
      "SELECT amount, currency, status, conversation_id FROM payment_intents",
    );
    expect(row).toMatchObject({ amount: 25000, currency: "mxn", status: "pending", conversation_id: "conv-1" });
  });

  it("sin conversación activa (getConversationId → null), igual genera el link", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "price_1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "plink_1", url: "https://x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const env = { DB: d1, STRIPE_SECRET_KEY: "sk_test_x" } as unknown as Env;
    const tool = sendPaymentLinkTool(env, () => null);
    const res = (await tool.execute!({ amount: 10, currency: "usd", description: "x" }, {} as any)) as any;
    expect(res.url).toBe("https://x");

    const row = await db.first<{ conversation_id: string | null }>("SELECT conversation_id FROM payment_intents");
    expect(row?.conversation_id).toBeNull();
  });

  it("si Stripe rechaza, no guarda nada y devuelve payment_link_failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const env = { DB: d1, STRIPE_SECRET_KEY: "sk_bad" } as unknown as Env;
    const tool = sendPaymentLinkTool(env, () => "conv-1");
    const res = (await tool.execute!({ amount: 10, currency: "mxn", description: "x" }, {} as any)) as any;

    expect(res.error).toBe("payment_link_failed");
    expect(res.message).toContain("Invalid API Key");
    const row = await db.first("SELECT * FROM payment_intents");
    expect(row).toBeNull();
  });
});
