import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { SettingsRepo } from "../../src/db/settings";
import { isLearnMode } from "../../src/learn/mapping";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`, "utf-8").toString("base64")}`,
};
const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" };

let env: Env;
let repo: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, DASHBOARD_PASSWORD: PASSWORD } as unknown as Env;
  repo = new SettingsRepo(new Db(d1));
});

describe("rutas admin de learn-mode", () => {
  it("start enciende learn-mode para el canal", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    expect(res.status).toBe(200);
    expect(await isLearnMode(repo, "whatsapp")).toBe(true);
  });

  it("stop lo apaga", async () => {
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    await adminApp.request("/learn/whatsapp/stop", { method: "POST", headers: AUTH }, env);
    expect(await isLearnMode(repo, "whatsapp")).toBe(false);
  });

  it("respeta la duración en minutos del body", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ minutes: 1 }) },
      env,
    );
    expect((await res.json() as any).minutes).toBe(1);
  });

  it("usa 15 minutos por defecto cuando no viene body", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    expect((await res.json() as any).minutes).toBe(15);
  });

  it("no afecta a otros canales", async () => {
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    expect(await isLearnMode(repo, "telegram")).toBe(false);
  });

  it("sin Basic Auth responde 401", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });
});
