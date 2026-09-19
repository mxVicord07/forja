/**
 * Contract tests for the control-plane API (src/api.ts). Verifies the
 * fail-closed Bearer guard and the response shapes of /api/health,
 * /api/metrics, and the routes agregadas al portar Forja Inbox
 * (/config, /cost, /leads, /pause). Real D1 via miniflare; the sub-app is
 * exercised directly (apiApp.request), the same way the admin tests hit
 * adminApp.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { apiApp, type MetricsResponse } from "../../src/api";
import { Db } from "../../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { BOT_VERSION } from "../../src/version";
import type { Env } from "../../src/env";

// GET /api/report/latest importa owner/report/build dinámicamente, que a su
// vez llama al LLM (skill /reportes) — mockeado para que este archivo no
// dependa de credenciales reales de proveedor (mismo patrón que
// test/flywheel/flywheel.test.ts).
const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...args: unknown[]) => generateTextMock(...args) }));
vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({ provider: "anthropic", modelId: "claude-haiku-test", model: {}, supportsPromptCache: true }),
  envKeyFor: () => undefined,
  fallbackModel: () => null,
}));

const TOKEN = "cp-secret-token";
const NOW = Date.now();
const IN_WINDOW = NOW - 60 * 60 * 1000; // 1h ago → inside the 7d window

let d1: any;
let db: Db;

/** env WITH the control-plane token configured (auth can pass). */
function authedEnv(): Env {
  return {
    DB: d1,
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Test",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    CONTROL_PLANE_TOKEN: TOKEN,
  } as unknown as Env;
}

/** env WITHOUT the token → every /api/* call must fail closed. */
function noTokenEnv(): Env {
  const e = authedEnv() as any;
  delete e.CONTROL_PLANE_TOKEN;
  return e as Env;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
});

/** Seed: 2 conversations (one escalated via a ticket), 3 messages, 2 leads. */
async function seedActivity() {
  await db.run(
    `INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at)
     VALUES ('cA','twilio','uA','A',?,?), ('cB','twilio','uB','B',?,?)`,
    [IN_WINDOW, IN_WINDOW, IN_WINDOW, IN_WINDOW],
  );
  await db.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES ('m1','cA','user','hola',?), ('m2','cA','assistant','buenas',?), ('m3','cB','user','info',?)`,
    [IN_WINDOW, IN_WINDOW, IN_WINDOW],
  );
  await db.run(
    `INSERT INTO leads (id, conversation_id, intent, created_at, updated_at)
     VALUES ('l1','cA','compra',?,?), ('l2','cB','duda',?,?)`,
    [IN_WINDOW, IN_WINDOW, IN_WINDOW, IN_WINDOW],
  );
  // conv A escalated to a human → one handoff ticket.
  await db.run(
    `INSERT INTO tickets (id, conversation_id, summary, transcript, created_at)
     VALUES ('t1','cA','handoff','...',?)`,
    [IN_WINDOW],
  );
}

describe("control-plane guard (fail-closed)", () => {
  for (const path of ["/health", "/metrics", "/config", "/cost", "/leads"]) {
    it(`${path}: 401 when CONTROL_PLANE_TOKEN is unset (even with a Bearer)`, async () => {
      const res = await apiApp.request(path, { headers: bearer(TOKEN) }, noTokenEnv());
      expect(res.status).toBe(401);
    });

    it(`${path}: 401 with token set but missing Bearer`, async () => {
      const res = await apiApp.request(path, {}, authedEnv());
      expect(res.status).toBe(401);
    });

    it(`${path}: 401 with token set but wrong Bearer`, async () => {
      const res = await apiApp.request(path, { headers: bearer("wrong-token") }, authedEnv());
      expect(res.status).toBe(401);
    });
  }
});

describe("GET /api/health", () => {
  it("200 + { ok, version, tier } with the right Bearer", async () => {
    const res = await apiApp.request("/health", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; tier: string };
    expect(body).toEqual({ ok: true, version: BOT_VERSION, tier: "pro" });
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });
});

describe("GET /api/metrics", () => {
  it("200 + correct shape and numeric aggregates with the right Bearer", async () => {
    await seedActivity();
    const res = await apiApp.request("/metrics?range=7d", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsResponse;

    expect(body.range).toBe("7d");
    expect(typeof body.leads).toBe("number");
    expect(typeof body.messages).toBe("number");
    expect(typeof body.conversations).toBe("number");
    expect(typeof body.health_score).toBe("number");

    // Seeded: 2 leads, 3 messages, 2 conversations, 1 of 2 escalated → score 50.
    expect(body.leads).toBe(2);
    expect(body.messages).toBe(3);
    expect(body.conversations).toBe(2);
    expect(body.health_score).toBe(50);
    expect(body.health_score).toBeGreaterThanOrEqual(0);
    expect(body.health_score).toBeLessThanOrEqual(100);
  });

  it("defaults to range=7d when the param is absent/invalid", async () => {
    const res = await apiApp.request("/metrics?range=bogus", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsResponse;
    expect(body.range).toBe("7d");
  });

  it("range=all counts everything and reports 100 with no traffic", async () => {
    const res = await apiApp.request("/metrics?range=all", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsResponse;
    expect(body.range).toBe("all");
    expect(body.conversations).toBe(0);
    expect(body.health_score).toBe(100); // no conversations ≠ unhealthy
  });
});

// Rutas agregadas al portar Forja Inbox (paquete Forja+ v1.0.76, adaptado a
// las capacidades reales de este fork).
describe("GET /api/config", () => {
  it("200 + resumen de negocio/canales/superpoderes/pausa", async () => {
    const res = await apiApp.request("/config", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      business: string;
      bot_name: string;
      channels: { id: string; name: string; connected: boolean }[];
      channels_total: number;
      paused: boolean;
      paused_mode: string;
      superpowers: Record<string, boolean>;
      open_tickets: number;
      tier: string;
      version: string;
      composio: { enabled: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.business).toBe("Test");
    expect(Array.isArray(body.channels)).toBe(true);
    expect(body.channels_total).toBe(body.channels.length);
    expect(body.paused).toBe(false);
    expect(body.paused_mode).toBe("off");
    expect(typeof body.superpowers).toBe("object");
    expect(body.open_tickets).toBe(0);
    expect(body.tier).toBe("pro");
    expect(body.version).toBe(BOT_VERSION);
    expect(body.composio.enabled).toBe(false); // sin COMPOSIO_API_KEY en el env de prueba
  });

  it("refleja bot_paused=1 como pausa manual", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.botPaused, "1");
    const res = await apiApp.request("/config", { headers: bearer(TOKEN) }, authedEnv());
    const body = (await res.json()) as { paused: boolean; paused_mode: string };
    expect(body.paused).toBe(true);
    expect(body.paused_mode).toBe("manual");
  });
});

describe("GET /api/cost", () => {
  it("200 + gasto en cero y presupuesto por default ($25) sin uso registrado", async () => {
    const res = await apiApp.request("/cost", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      month_usd: number;
      budget_usd: number | null;
      budget_is_default: boolean;
      pct: number | null;
      downgraded: boolean;
      currency: string;
      ledger_usd: number;
      breakdown: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.month_usd).toBe(0);
    expect(body.budget_usd).toBe(25);
    expect(body.budget_is_default).toBe(true);
    expect(body.pct).toBe(0);
    expect(body.downgraded).toBe(false);
    expect(body.currency).toBe("USD");
    expect(body.ledger_usd).toBe(0);
    expect(body.breakdown).toEqual([]);
  });

  it("un monthly_budget explícito en 0 se reporta como sin tope", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.monthlyBudget, "0");
    const res = await apiApp.request("/cost", { headers: bearer(TOKEN) }, authedEnv());
    const body = (await res.json()) as { budget_usd: number | null; budget_is_default: boolean; pct: number | null };
    expect(body.budget_usd).toBeNull();
    expect(body.budget_is_default).toBe(false);
    expect(body.pct).toBeNull();
  });
});

describe("GET /api/leads", () => {
  it("200 + leads recientes con contacto enmascarado, más recientes primero", async () => {
    await seedActivity();
    const res = await apiApp.request("/leads", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      leads: { id: string; conversation_id: string | null; channel: string | null; status: string }[];
      count: number;
      next_cursor: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.leads.map((l) => l.id).sort()).toEqual(["l1", "l2"]);
    const l1 = body.leads.find((l) => l.id === "l1")!;
    expect(l1.conversation_id).toBe("cA");
    // El id de conversación real es `${channel}:${channelUserId}` (makeConvId);
    // el seed de este archivo usa ids planos ("cA"), así que sin ":" el split
    // devuelve el id entero tal cual.
    expect(l1.channel).toBe("cA");
    expect(l1.status).toBe("new");
  });

  it("filtra por status válido y rechaza uno inventado", async () => {
    await seedActivity();
    const okRes = await apiApp.request("/leads?status=new", { headers: bearer(TOKEN) }, authedEnv());
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { count: number };
    expect(okBody.count).toBe(2);

    const badRes = await apiApp.request("/leads?status=bogus", { headers: bearer(TOKEN) }, authedEnv());
    expect(badRes.status).toBe(400);
  });
});

describe("POST /api/pause", () => {
  it("401 sin Bearer válido", async () => {
    const res = await apiApp.request("/pause", { method: "POST", body: JSON.stringify({ until: "manual" }) }, authedEnv());
    expect(res.status).toBe(401);
  });

  it('{until:"manual"} pausa hasta que el dueño lo prenda', async () => {
    const res = await apiApp.request(
      "/pause",
      { method: "POST", headers: bearer(TOKEN), body: JSON.stringify({ until: "manual" }) },
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; paused: boolean; paused_mode: string };
    expect(body.ok).toBe(true);
    expect(body.paused).toBe(true);
    expect(body.paused_mode).toBe("manual");
    expect(await new SettingsRepo(db).get(SETTING_KEYS.botPaused)).toBe("1");
  });

  it("{until:null} reanuda el bot", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.botPaused, "1");
    const res = await apiApp.request(
      "/pause",
      { method: "POST", headers: bearer(TOKEN), body: JSON.stringify({ until: null }) },
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paused: boolean; paused_mode: string };
    expect(body.paused).toBe(false);
    expect(body.paused_mode).toBe("off");
  });

  it("un epoch en el pasado se rechaza (400 invalid_until)", async () => {
    const res = await apiApp.request(
      "/pause",
      { method: "POST", headers: bearer(TOKEN), body: JSON.stringify({ until: Date.now() - 1000 }) },
      authedEnv(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_until");
  });

  it("un epoch futuro pausa con hora de término", async () => {
    const until = Date.now() + 60 * 60 * 1000;
    const res = await apiApp.request(
      "/pause",
      { method: "POST", headers: bearer(TOKEN), body: JSON.stringify({ until }) },
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paused: boolean; paused_mode: string; paused_until: number };
    expect(body.paused).toBe(true);
    expect(body.paused_mode).toBe("until");
    expect(body.paused_until).toBe(until);
  });
});

describe("GET /api/report/latest", () => {
  it("401 sin Bearer válido", async () => {
    const res = await apiApp.request("/report/latest", {}, authedEnv());
    expect(res.status).toBe(401);
  });

  it("403 pro_required en tier free", async () => {
    const res = await apiApp.request(
      "/report/latest",
      { headers: bearer(TOKEN) },
      { ...authedEnv(), BOT_TIER: "free" },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("pro_required");
  });

  it("404 no_report sin cron previo y sin ?fresh=1", async () => {
    const res = await apiApp.request("/report/latest", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("no_report");
  });

  it("?fresh=1 arma uno al vuelo SIN persistirlo (no escribe report_last_json)", async () => {
    const res = await apiApp.request("/report/latest?fresh=1", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; report: { title: string }; body_markdown: string };
    expect(body.ok).toBe(true);
    expect(body.report.title).toContain("Test"); // BUSINESS_NAME de authedEnv()
    expect(body.body_markdown).toContain("Test");

    // Confirma que NO quedó guardado — una llamada normal después sigue en 404.
    const again = await apiApp.request("/report/latest", { headers: bearer(TOKEN) }, authedEnv());
    expect(again.status).toBe(404);
  });

  it("sirve el snapshot guardado por el cron sin volver a llamar al modelo", async () => {
    const snap = {
      generated_at: NOW,
      period: { from: NOW - 1000, to: NOW },
      title: "Tu resumen de hoy — Test",
      empty: true,
      summary: "Día tranquilo.",
      insights: [],
      actions: [],
      stats: { messages: 0, conversations: 0, leads: 0, hot_leads: 0, tickets_opened: 0, tickets_resolved: 0, upset: 0 },
      prev: { messages: 0, conversations: 0, leads: 0, hot_leads: 0, tickets_opened: 0, tickets_resolved: 0, upset: 0 },
      topics: [],
      missed_questions: [],
    };
    await new SettingsRepo(db).set(SETTING_KEYS.reportLastJson, JSON.stringify(snap));

    const res = await apiApp.request("/report/latest", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(200);
    expect(generateTextMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { ok: boolean; report: typeof snap; body_markdown: string };
    expect(body.report).toEqual(snap);
    expect(body.body_markdown).toContain("Día tranquilo.");
  });

  it("404 no_report si el snapshot guardado está corrupto", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.reportLastJson, "{no es json");
    const res = await apiApp.request("/report/latest", { headers: bearer(TOKEN) }, authedEnv());
    expect(res.status).toBe(404);
  });
});
