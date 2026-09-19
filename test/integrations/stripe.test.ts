import { describe, it, expect, vi, afterEach } from "vitest";
import { stripeConfigured, createPaymentLink, verifyStripeSignature } from "../../src/integrations/stripe";
import type { Env } from "../../src/env";

const env = (over: Partial<Env> = {}) => ({ ...over }) as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("stripeConfigured", () => {
  it("false sin STRIPE_SECRET_KEY", () => {
    expect(stripeConfigured(env())).toBe(false);
  });

  it("true con STRIPE_SECRET_KEY", () => {
    expect(stripeConfigured(env({ STRIPE_SECRET_KEY: "sk_test_x" }))).toBe(true);
  });
});

describe("createPaymentLink", () => {
  it("hace 2 POST (precio inline → payment link) y arma la metadata correcta", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "price_1" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "plink_1", url: "https://buy.stripe.com/x" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createPaymentLink(env({ STRIPE_SECRET_KEY: "sk_test_x" }), {
      amount: 250,
      currency: "mxn",
      description: "Corte + barba",
      intentId: "intent-1",
      conversationId: "conv-1",
    });

    expect(out).toEqual({ url: "https://buy.stripe.com/x", providerId: "plink_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [priceUrl, priceInit] = fetchMock.mock.calls[0] as any[];
    expect(priceUrl).toBe("https://api.stripe.com/v1/prices");
    const priceBody = new URLSearchParams(priceInit.body as string);
    expect(priceBody.get("currency")).toBe("mxn");
    expect(priceBody.get("unit_amount")).toBe("25000"); // centavos
    expect(priceBody.get("product_data[name]")).toBe("Corte + barba");

    const [linkUrl, linkInit] = fetchMock.mock.calls[1] as any[];
    expect(linkUrl).toBe("https://api.stripe.com/v1/payment_links");
    const linkBody = new URLSearchParams(linkInit.body as string);
    expect(linkBody.get("line_items[0][price]")).toBe("price_1");
    expect(linkBody.get("metadata[intent_id]")).toBe("intent-1");
    expect(linkBody.get("metadata[conversation_id]")).toBe("conv-1");
    expect(linkBody.get("payment_intent_data[metadata][intent_id]")).toBe("intent-1");
  });

  it("omite metadata[conversation_id] cuando no hay conversationId", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "price_1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "plink_1", url: "https://x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await createPaymentLink(env({ STRIPE_SECRET_KEY: "sk_test_x" }), {
      amount: 100,
      currency: "usd",
      description: "Cobro",
      intentId: "intent-2",
    });

    const linkBody = new URLSearchParams((fetchMock.mock.calls[1] as any[])[1].body as string);
    expect(linkBody.has("metadata[conversation_id]")).toBe(false);
  });

  it("lanza con el mensaje de error de Stripe si la API rechaza", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createPaymentLink(env({ STRIPE_SECRET_KEY: "sk_bad" }), {
        amount: 10,
        currency: "mxn",
        description: "x",
        intentId: "i1",
      }),
    ).rejects.toThrow(/Invalid API Key/);
  });
});

describe("verifyStripeSignature", () => {
  async function sign(secret: string, t: number, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `t=${t},v1=${hex}`;
  }

  const SECRET = "whsec_test";
  const BODY = JSON.stringify({ type: "payment_intent.succeeded" });

  it("acepta una firma válida y fresca", async () => {
    const now = 1_800_000_000_000;
    const header = await sign(SECRET, Math.floor(now / 1000), BODY);
    expect(await verifyStripeSignature(SECRET, BODY, header, now)).toBe(true);
  });

  it("rechaza si el body fue alterado", async () => {
    const now = 1_800_000_000_000;
    const header = await sign(SECRET, Math.floor(now / 1000), BODY);
    expect(await verifyStripeSignature(SECRET, BODY + "x", header, now)).toBe(false);
  });

  it("rechaza una firma vieja (fuera de la ventana de 5 min)", async () => {
    const now = 1_800_000_000_000;
    const old = Math.floor(now / 1000) - 301;
    const header = await sign(SECRET, old, BODY);
    expect(await verifyStripeSignature(SECRET, BODY, header, now)).toBe(false);
  });

  it("rechaza sin header", async () => {
    expect(await verifyStripeSignature(SECRET, BODY, null)).toBe(false);
  });

  it("rechaza un header malformado (sin t o sin v1)", async () => {
    expect(await verifyStripeSignature(SECRET, BODY, "basura")).toBe(false);
    expect(await verifyStripeSignature(SECRET, BODY, "t=123")).toBe(false);
  });
});
