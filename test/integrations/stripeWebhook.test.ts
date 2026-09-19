import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { handleStripeWebhook } from "../../src/integrations/stripeWebhook";
import { Db } from "../../src/db/client";
import type { Env } from "../../src/env";

const SECRET = "whsec_test";

async function signedReq(body: string, secret = SECRET, tSeconds?: number): Promise<Request> {
  const t = tSeconds ?? Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://bot.example/webhooks/stripe", {
    method: "POST",
    body,
    headers: { "Stripe-Signature": `t=${t},v1=${hex}` },
  });
}

let d1: any;
let db: Db;
let env: Env;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  db = new Db(d1);
  env = {
    DB: d1,
    STRIPE_WEBHOOK_SECRET: SECRET,
    DASHBOARD_BASE_URL: "https://bot.example",
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedIntent(overrides: Partial<{ id: string; status: string; conversationId: string | null }> = {}) {
  const id = overrides.id ?? "intent-1";
  await db.run(
    `INSERT INTO payment_intents (id, conversation_id, amount, currency, description, provider, status, created_at)
     VALUES (?, ?, 25000, 'mxn', 'Corte + barba', 'stripe', ?, ?)`,
    [id, overrides.conversationId ?? null, overrides.status ?? "pending", Date.now()],
  );
  return id;
}

describe("handleStripeWebhook", () => {
  it("503 sin STRIPE_WEBHOOK_SECRET configurado", async () => {
    const res = await handleStripeWebhook(
      new Request("https://x", { method: "POST", body: "{}" }),
      { DB: d1 } as unknown as Env,
    );
    expect(res.status).toBe(503);
  });

  it("400 con firma inválida", async () => {
    const req = new Request("https://bot.example/webhooks/stripe", {
      method: "POST",
      body: "{}",
      headers: { "Stripe-Signature": "t=1,v1=firmamala" },
    });
    const res = await handleStripeWebhook(req, env);
    expect(res.status).toBe(400);
  });

  it("400 con JSON malformado (aunque la firma sea válida sobre ese texto)", async () => {
    const req = await signedReq("no es json");
    const res = await handleStripeWebhook(req, env);
    expect(res.status).toBe(400);
  });

  it("200 e ignora eventos que no son de pago exitoso", async () => {
    const req = await signedReq(JSON.stringify({ type: "customer.created" }));
    const res = await handleStripeWebhook(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: "customer.created" });
  });

  it("200 sin intent_id en la metadata: no revienta, solo lo señala", async () => {
    const req = await signedReq(
      JSON.stringify({ type: "payment_intent.succeeded", data: { object: { metadata: {} } } }),
    );
    const res = await handleStripeWebhook(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, no_intent: true });
  });

  it("200 con un intent_id que no existe en D1", async () => {
    const req = await signedReq(
      JSON.stringify({
        type: "payment_intent.succeeded",
        data: { object: { metadata: { intent_id: "no-existe" } } },
      }),
    );
    const res = await handleStripeWebhook(req, env);
    expect(await res.json()).toMatchObject({ ok: true, unknown_intent: true });
  });

  it("marca el intent como pagado (payment_intent.succeeded)", async () => {
    const id = await seedIntent();
    const req = await signedReq(
      JSON.stringify({ type: "payment_intent.succeeded", data: { object: { metadata: { intent_id: id } } } }),
    );
    const res = await handleStripeWebhook(req, env);
    expect(res.status).toBe(200);
    const row = await db.first<{ status: string; paid_at: number | null }>(
      "SELECT status, paid_at FROM payment_intents WHERE id = ?",
      [id],
    );
    expect(row?.status).toBe("paid");
    expect(row?.paid_at).not.toBeNull();
  });

  it("también confirma con checkout.session.completed + payment_status=paid", async () => {
    const id = await seedIntent();
    const req = await signedReq(
      JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { payment_status: "paid", metadata: { intent_id: id } } },
      }),
    );
    await handleStripeWebhook(req, env);
    const row = await db.first<{ status: string }>("SELECT status FROM payment_intents WHERE id = ?", [id]);
    expect(row?.status).toBe("paid");
  });

  it("checkout.session.completed sin payment_status=paid se ignora", async () => {
    const id = await seedIntent();
    const req = await signedReq(
      JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { payment_status: "unpaid", metadata: { intent_id: id } } },
      }),
    );
    const res = await handleStripeWebhook(req, env);
    expect(await res.json()).toMatchObject({ ok: true, ignored: "checkout.session.completed" });
    const row = await db.first<{ status: string }>("SELECT status FROM payment_intents WHERE id = ?", [id]);
    expect(row?.status).toBe("pending");
  });

  it("idempotente: un intent ya pagado no se reprocesa ni reavisa", async () => {
    const id = await seedIntent({ status: "paid" });
    const req = await signedReq(
      JSON.stringify({ type: "payment_intent.succeeded", data: { object: { metadata: { intent_id: id } } } }),
    );
    const res = await handleStripeWebhook(req, env);
    expect(await res.json()).toMatchObject({ ok: true, already_paid: true });
  });

  it("avisa al dueño por Telegram cuando está configurado", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const id = await seedIntent();
    const req = await signedReq(
      JSON.stringify({ type: "payment_intent.succeeded", data: { object: { metadata: { intent_id: id } } } }),
    );
    await handleStripeWebhook(req, {
      ...env,
      TELEGRAM_BOT_TOKEN: "tok",
      OWNER_TELEGRAM_CHAT_ID: "999",
    } as unknown as Env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toContain("api.telegram.org/bottok/sendMessage");
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("999");
    expect(body.text).toContain("Te pagaron");
    expect(body.text).toContain("$250.00 MXN");
    expect(body.text).toContain("/admin/cobros");
  });

  it("sin Telegram configurado: no lanza, solo logea (fail-open)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await seedIntent();
    const req = await signedReq(
      JSON.stringify({ type: "payment_intent.succeeded", data: { object: { metadata: { intent_id: id } } } }),
    );
    const res = await handleStripeWebhook(req, env);
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
  });
});
