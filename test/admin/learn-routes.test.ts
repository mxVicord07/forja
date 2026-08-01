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
  // Estos tests ejercitan el comportamiento "feature encendida" (existente
  // antes del gate). El gate en sí (apagado por defecto, 403) se prueba en
  // el describe de más abajo con su propio env.
  env = { DB: d1, DASHBOARD_PASSWORD: PASSWORD, LEARN_MODE_ENABLED: "1" } as unknown as Env;
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

  // Re-review: comparar con `includes` sobre el header ENTERO deja pasar
  // "text/plain;charset=application/json" — la essence real es text/plain
  // (CORS-safelisted), así que el navegador NO manda preflight: justo la
  // propiedad en la que se apoya esta mitigación. Con `includes`, ese ataque
  // pasaba el gate (c.req.json() fallaba, el .catch(() => ({})) lo tapaba, y
  // seguía el camino feliz con minutes=15). Este es el vector real.
  it("rechaza el vector de essence falsa (text/plain con 'application/json' en el charset)", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: { ...AUTH, "Content-Type": "text/plain;charset=application/json" } },
      env,
    );
    expect(res.status).toBe(415);
    expect(await isLearnMode(repo, "whatsapp")).toBe(false);
  });

  it("acepta application/json con charset y espacios (caso legítimo)", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/json; charset=utf-8" } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("acepta el media type en mayúsculas", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: { ...AUTH, "Content-Type": "APPLICATION/JSON" } },
      env,
    );
    expect(res.status).toBe(200);
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

describe("gate LEARN_MODE_ENABLED (apagado por defecto)", () => {
  let offEnv: Env;
  let onEnv: Env;
  let offRepo: SettingsRepo;

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    // Sin LEARN_MODE_ENABLED -> apagado por defecto.
    offEnv = { DB: d1, DASHBOARD_PASSWORD: PASSWORD } as unknown as Env;
    onEnv = { DB: d1, DASHBOARD_PASSWORD: PASSWORD, LEARN_MODE_ENABLED: "1" } as unknown as Env;
    offRepo = new SettingsRepo(new Db(d1));
  });

  it("start responde 403 cuando el gate está apagado (default) y no enciende nada", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, offEnv);
    expect(res.status).toBe(403);
    expect(await isLearnMode(offRepo, "whatsapp")).toBe(false);
  });

  it("start funciona igual que antes cuando el gate está prendido", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, onEnv);
    expect(res.status).toBe(200);
    expect(await isLearnMode(offRepo, "whatsapp")).toBe(true);
  });

  it("con el gate apagado, sin Basic Auth sigue respondiendo 401 (la auth corre antes)", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      offEnv,
    );
    expect(res.status).toBe(401);
  });

  it("stop funciona con el gate apagado (kill switch siempre disponible)", async () => {
    // Se prende con el gate activo…
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, onEnv);
    expect(await isLearnMode(offRepo, "whatsapp")).toBe(true);
    // …y se puede apagar aunque el request llegue con el gate desactivado.
    const res = await adminApp.request("/learn/whatsapp/stop", { method: "POST", headers: JSON_HEADERS }, offEnv);
    expect(res.status).toBe(200);
    expect(await isLearnMode(offRepo, "whatsapp")).toBe(false);
  });

  it("valores raros del gate (\"0\", \"yes\", \" TRUE \") se interpretan correctamente en start", async () => {
    const zeroEnv = { ...offEnv, LEARN_MODE_ENABLED: "0" } as unknown as Env;
    const yesEnv = { ...offEnv, LEARN_MODE_ENABLED: "yes" } as unknown as Env;
    const trueSpacedEnv = { ...offEnv, LEARN_MODE_ENABLED: " TRUE " } as unknown as Env;

    expect((await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, zeroEnv)).status).toBe(403);
    expect((await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, yesEnv)).status).toBe(403);
    expect((await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: JSON_HEADERS }, trueSpacedEnv)).status).toBe(200);
  });
});
