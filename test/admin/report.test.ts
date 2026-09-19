/** GET /admin/report (página completa del reporte diseñado, skill /reportes). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import type { Env } from "../../src/env";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...args: unknown[]) => generateTextMock(...args) }));
vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({ provider: "anthropic", modelId: "claude-haiku-test", model: {}, supportsPromptCache: true }),
  envKeyFor: () => undefined,
  fallbackModel: () => null,
}));

const PASSWORD = "secret123";
function basicAuthHeader(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const b64 = typeof btoa === "function" ? btoa(raw) : Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${b64}`;
}
const AUTH = { Authorization: basicAuthHeader("admin", PASSWORD) };

let env: Env;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = {
    DB: d1,
    DASHBOARD_PASSWORD: PASSWORD,
    BOT_TIER: "pro",
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Hugo Hair",
    BOT_LANGUAGE: "es",
    DASHBOARD_BASE_URL: "https://bot.example",
  } as unknown as Env;
  generateTextMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("GET /admin/report", () => {
  it("401 sin Basic Auth", async () => {
    const res = await adminApp.request("/report", {}, env);
    expect(res.status).toBe(401);
  });

  // El gate Pro (routes.ts#PRO_GATE) compara contra rutas con prefijo
  // "/admin/..." porque lee c.req.path del request MONTADO (app.route("/admin",
  // adminApp) en index.ts) — verificado empíricamente que ahí SÍ trae el
  // prefijo completo. Llamando adminApp.request() directo (como TODO el resto
  // de esta suite, para no arrastrar el mock de "agents"/cloudflare:workers
  // que exige montar el app completo) el path nunca lleva "/admin", así que
  // el middleware jamás matchea — ni con este ni con ningún otro tab Pro
  // existente (insights/costs/stats/mejoras/campanas tampoco lo prueban a
  // este nivel). No es un hueco de ESTE cambio: es una limitación conocida de
  // cómo se testea adminApp en todo el repo. El nav-lock (que free no vea el
  // link) sí está cubierto en test/admin/dashboard-tier.test.ts.

  it("200: devuelve la página completa (doctype propio, no el shell del panel)", async () => {
    const res = await adminApp.request("/report", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("Hugo Hair");
    // NO trae el sidebar del panel (layout.ts) — es una página autocontenida.
    expect(html).not.toContain("Bandeja");
  });

  it("sin actividad: sale el resumen de día tranquilo", async () => {
    const res = await adminApp.request("/report", { headers: AUTH }, env);
    const html = await res.text();
    expect(html).toContain("Día tranquilo");
  });
});
