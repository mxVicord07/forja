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
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, env);
    expect(res.status).toBe(200);
    expect(await isLearnMode(repo, "whatsapp")).toBe(true);
  });

  it("stop lo apaga", async () => {
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, env);
    await adminApp.request("/learn/whatsapp/stop", { method: "POST", headers: JSON_HEADERS }, env);
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
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, env);
    expect((await res.json() as any).minutes).toBe(15);
  });

  it("no afecta a otros canales", async () => {
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, env);
    expect(await isLearnMode(repo, "telegram")).toBe(false);
  });

  it("sin Basic Auth responde 401", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  // Hallazgo 2: DASHBOARD_PUBLIC="1" es un bypass de solo-lectura del panel;
  // nunca debe alcanzar al interruptor de captura de payloads crudos.
  it("DASHBOARD_PUBLIC=1 NO exime a /learn/* del Basic Auth", async () => {
    const publicEnv = { ...env, DASHBOARD_PUBLIC: "1" } as unknown as Env;
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      publicEnv,
    );
    expect(res.status).toBe(401);
  });

  it("DASHBOARD_PUBLIC=1 sigue eximiendo rutas de solo lectura", async () => {
    const publicEnv = { ...env, DASHBOARD_PUBLIC: "1" } as unknown as Env;
    const res = await adminApp.request("/projects", {}, publicEnv);
    expect(res.status).toBe(200);
  });

  // Hallazgo 3: sin Content-Type: application/json, el POST es una "simple
  // request" cross-origin (sin preflight) — CSRF fácil. Exigir JSON fuerza el
  // preflight de CORS y bloquea el ataque de página hostil + Basic cacheado.
  it("sin Content-Type: application/json responde 415", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    expect(res.status).toBe(415);
    expect(await isLearnMode(repo, "whatsapp")).toBe(false);
  });

  it("stop también exige Content-Type: application/json", async () => {
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, env);
    const res = await adminApp.request("/learn/whatsapp/stop", { method: "POST", headers: AUTH }, env);
    expect(res.status).toBe(415);
    expect(await isLearnMode(repo, "whatsapp")).toBe(true); // no se apagó
  });

  // Hallazgo 4: minutes sin tope anula la "expiración automática" (1e9 min ≈
  // 1900 años encendido). Topamos a 60; default 15 se mantiene.
  it("topa minutes a 60 aunque pidan más", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ minutes: 1e9 }) },
      env,
    );
    expect((await res.json() as any).minutes).toBe(60);
  });

  it("minutes inválido (negativo/NaN) cae al default 15", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ minutes: -5 }) },
      env,
    );
    expect((await res.json() as any).minutes).toBe(15);
  });

  // Hallazgo 5: :channel sin validar deja escribir cualquier fila
  // learn:<lo-que-sea>:until en settings. Solo los ChannelId reales.
  it("rechaza un :channel que no es un ChannelId válido", async () => {
    const res = await adminApp.request(
      "/learn/not-a-channel/start",
      { method: "POST", headers: JSON_HEADERS },
      env,
    );
    expect(res.status).toBe(400);
    expect(await isLearnMode(repo, "not-a-channel")).toBe(false);
  });

  it("stop también rechaza un :channel inválido", async () => {
    const res = await adminApp.request(
      "/learn/not-a-channel/stop",
      { method: "POST", headers: JSON_HEADERS },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("acepta cada ChannelId válido", async () => {
    for (const ch of ["manychat", "telegram", "twilio", "messenger", "instagram", "whatsapp"]) {
      const res = await adminApp.request(`/learn/${ch}/start`, { method: "POST", headers: JSON_HEADERS }, env);
      expect(res.status).toBe(200);
    }
  });
});
