import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { demoEnabled, demoOverLimit, demoTurnsUsed, demoPage, demoPoll } from "../src/demo";
import type { Env } from "../src/env";

let env: Env;

// Monta las dos rutas GET exactamente como src/index.ts, para probar el
// contrato HTTP real (query params, status codes) y no solo las funciones puras.
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/demo", (c) => demoPage(c));
  app.get("/demo/poll", (c) => demoPoll(c));
  return app;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = {
    DB: d1,
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Hugo Hair",
    BOT_LANGUAGE: "es",
  } as unknown as Env;
});

describe("demoEnabled", () => {
  it("false when DEMO_MODE is unset (default OFF)", () => {
    expect(demoEnabled(env)).toBe(false);
  });

  it("false for any value other than 'on'", () => {
    expect(demoEnabled({ ...env, DEMO_MODE: "true" } as Env)).toBe(false);
    expect(demoEnabled({ ...env, DEMO_MODE: "1" } as Env)).toBe(false);
  });

  it("true only for 'on' (case-insensitive)", () => {
    expect(demoEnabled({ ...env, DEMO_MODE: "on" } as Env)).toBe(true);
    expect(demoEnabled({ ...env, DEMO_MODE: "ON" } as Env)).toBe(true);
  });
});

describe("demoOverLimit", () => {
  it("false below the 40-turn cap, true at/over it", () => {
    expect(demoOverLimit(0)).toBe(false);
    expect(demoOverLimit(39)).toBe(false);
    expect(demoOverLimit(40)).toBe(true);
    expect(demoOverLimit(41)).toBe(true);
  });
});

describe("demoTurnsUsed", () => {
  it("counts only 'user' role messages for that session's conversation", async () => {
    const db = env.DB;
    await db
      .prepare(
        "INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?, 'web', ?, ?, ?)",
      )
      .bind("conv-1", "sess-1", Date.now(), Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("m1", "conv-1", "user", "hola", Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("m2", "conv-1", "assistant", "¡hola!", Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("m3", "conv-1", "user", "otra pregunta", Date.now())
      .run();

    expect(await demoTurnsUsed(env, "sess-1")).toBe(2);
  });

  it("0 for a session with no conversation yet", async () => {
    expect(await demoTurnsUsed(env, "sess-nueva")).toBe(0);
  });
});

describe("GET /demo", () => {
  it("404 when DEMO_MODE is off (default)", async () => {
    const res = await makeApp().request("/demo", {}, env);
    expect(res.status).toBe(404);
  });

  it("renders the chat page with the business name when DEMO_MODE=on", async () => {
    const res = await makeApp().request("/demo", {}, { ...env, DEMO_MODE: "on" } as Env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hugo Hair");
    expect(html).toContain("forja_demo_session");
  });

  it("escapes the business name against XSS", async () => {
    const res = await makeApp().request(
      "/demo",
      {},
      { ...env, DEMO_MODE: "on", BUSINESS_NAME: '<script>alert(1)</script>' } as Env,
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("GET /demo/poll", () => {
  it("404 when DEMO_MODE is off (default)", async () => {
    const res = await makeApp().request("/demo/poll?session=sess-1", {}, env);
    expect(res.status).toBe(404);
  });

  it("400 when session is missing", async () => {
    const res = await makeApp().request("/demo/poll", {}, { ...env, DEMO_MODE: "on" } as Env);
    expect(res.status).toBe(400);
  });

  it("empty list for a session with no conversation yet", async () => {
    const res = await makeApp().request(
      "/demo/poll?session=sess-nueva",
      {},
      { ...env, DEMO_MODE: "on" } as Env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messages: [] });
  });

  it("returns only assistant messages newer than 'after'", async () => {
    const demoEnv = { ...env, DEMO_MODE: "on" } as Env;
    const db = env.DB;
    await db
      .prepare(
        "INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?, 'web', ?, ?, ?)",
      )
      .bind("conv-2", "sess-2", 1000, 1000)
      .run();
    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("m1", "conv-2", "user", "hola", 1000)
      .run();
    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("m2", "conv-2", "assistant", "¡hola! ¿en qué ayudo?", 2000)
      .run();

    const res = await makeApp().request("/demo/poll?session=sess-2&after=1500", {}, demoEnv);
    const body = (await res.json()) as { ok: boolean; messages: { text: string; at: number }[] };
    expect(body.ok).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe("¡hola! ¿en qué ayudo?");
  });
});
