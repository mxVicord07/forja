/** GET /admin/cobros (tab Cobros, skill /cobros). */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";

function basicAuthHeader(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const b64 = typeof btoa === "function" ? btoa(raw) : Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${b64}`;
}

const AUTH = { Authorization: basicAuthHeader("admin", PASSWORD) };

let env: Env;
let d1: any;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  db = new Db(d1);
  env = {
    DB: d1,
    DASHBOARD_PASSWORD: PASSWORD,
    BOT_TIER: "pro",
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Test Biz",
    BOT_LANGUAGE: "es",
  } as unknown as Env;
});

describe("GET /admin/cobros", () => {
  it("401 sin Basic Auth", async () => {
    const res = await adminApp.request("/cobros", {}, env);
    expect(res.status).toBe(401);
  });

  it("sin STRIPE_SECRET_KEY: banner de conectar Stripe + prompt para copiar", async () => {
    const res = await adminApp.request("/cobros", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Conecta Stripe para empezar a cobrar");
    expect(html).toContain("Pégale esto a tu agente");
  });

  it("con Stripe conectado pero payments_enabled apagado: avisa que falta prender el switch", async () => {
    const res = await adminApp.request(
      "/cobros",
      { headers: AUTH },
      { ...env, STRIPE_SECRET_KEY: "sk_test_x" } as unknown as Env,
    );
    const html = await res.text();
    expect(html).toContain("Stripe conectado, pero Cobros sigue apagado");
  });

  it("estado vacío cuando no hay cobros generados", async () => {
    const res = await adminApp.request(
      "/cobros",
      { headers: AUTH },
      { ...env, STRIPE_SECRET_KEY: "sk_test_x" } as unknown as Env,
    );
    const html = await res.text();
    expect(html).toContain("Aún no se ha generado ningún cobro");
  });

  it("lista un cobro pagado con su monto formateado", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.paymentsEnabled, "1");
    await db.run(
      `INSERT INTO payment_intents (id, conversation_id, amount, currency, description, provider, status, created_at, paid_at)
       VALUES ('pi_1', NULL, 25000, 'mxn', 'Corte + barba', 'stripe', 'paid', ?, ?)`,
      [Date.now(), Date.now()],
    );
    const res = await adminApp.request(
      "/cobros",
      { headers: AUTH },
      { ...env, STRIPE_SECRET_KEY: "sk_test_x" } as unknown as Env,
    );
    const html = await res.text();
    expect(html).toContain("Corte + barba");
    expect(html).toContain("Pagado");
    expect(html).not.toContain("sigue apagado"); // payments_enabled=1, no debe salir el aviso
    expect(html).not.toContain("Aún no se ha generado");
  });

  it("suma correctamente cobrado vs. pendiente en las stat cards", async () => {
    await db.run(
      `INSERT INTO payment_intents (id, amount, currency, description, provider, status, created_at)
       VALUES ('pi_paid', 10000, 'mxn', 'A', 'stripe', 'paid', ?),
              ('pi_pending', 5000, 'mxn', 'B', 'stripe', 'pending', ?)`,
      [Date.now(), Date.now()],
    );
    const res = await adminApp.request(
      "/cobros",
      { headers: AUTH },
      { ...env, STRIPE_SECRET_KEY: "sk_test_x" } as unknown as Env,
    );
    const html = await res.text();
    // $100.00 cobrado, $50.00 pendiente (MXN, locale es-MX)
    expect(html).toMatch(/\$100\.00/);
    expect(html).toMatch(/\$50\.00/);
  });
});
