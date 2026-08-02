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
});
