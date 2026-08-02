import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`, "utf-8").toString("base64")}` };

let env: Env;
let repo: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    DASHBOARD_PASSWORD: PASSWORD,
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Test Business",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
  } as unknown as Env;
  repo = new SettingsRepo(new Db(d1));
});

describe("GET /admin/instruccion-maestra.md", () => {
  it("requires auth", async () => {
    const res = await adminApp.request("/instruccion-maestra.md", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns markdown with the effective prompt and a changelog", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido", "owner");
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# Instrucción Maestra");
    expect(body).toContain("## Prompt efectivo");
    expect(body).toContain("## Changelog");
    expect(body).toContain("owner");
  });

  it("warns when system_prompt_override is active", async () => {
    await repo.set(SETTING_KEYS.systemPromptOverride, "prompt manual custom", "owner");
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, env);
    const body = await res.text();
    expect(body).toContain("⚠️ Avisos");
    expect(body).toContain("system_prompt_override");
  });

  it("never leaks llm_api_key in plaintext", async () => {
    await repo.set(SETTING_KEYS.llmApiKey, "sk-super-secret-value", "owner");
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, env);
    const body = await res.text();
    expect(body).not.toContain("sk-super-secret-value");
  });

  it("returns 503 instead of a partial document when composition fails", async () => {
    // Force a failure inside renderInstruccionMaestraDoc by breaking the DB
    // binding after setup — simplest reliable way without a full mock:
    const brokenEnv = { ...env, DB: undefined } as unknown as Env;
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, brokenEnv);
    expect(res.status).toBe(503);
  });

  // Hallazgo 1 (revisión final de rama): learn:<channel>:<kind> guarda el
  // payload CRUDO de un webhook entrante (teléfono, texto del cliente,
  // nombre de perfil). No debe filtrarse en texto plano al changelog.
  it("no filtra el payload crudo de una captura learn:* en el changelog", async () => {
    await repo.set(
      "learn:whatsapp:capture:text",
      JSON.stringify({ phone: "+52123456789", text: "mi tarjeta es 4111111111111111" }),
      "system",
    );
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, env);
    const body = await res.text();
    expect(body).not.toContain("+52123456789");
    expect(body).not.toContain("4111111111111111");
    expect(body).toContain("(valor oculto)");
  });

  // Hallazgo 6 (revisión final de rama): DASHBOARD_PUBLIC="1" es un bypass de
  // solo-lectura del panel, pero este endpoint es el export más concentrado
  // de todo el panel (prompt completo + historial de 365 días) — nunca debe
  // quedar exento del Basic Auth, igual que /admin/learn/*.
  it("DASHBOARD_PUBLIC=1 NO exime a instruccion-maestra.md del Basic Auth", async () => {
    const publicEnv = { ...env, DASHBOARD_PUBLIC: "1" } as unknown as Env;
    const res = await adminApp.request("/instruccion-maestra.md", {}, publicEnv);
    expect(res.status).toBe(401);
  });
});
