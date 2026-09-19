import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../../helpers/miniflareSetup";
import { Db } from "../../../src/db/client";
import { ConversationsRepo } from "../../../src/db/conversations";
import { MessagesRepo } from "../../../src/db/messages";
import { SettingsRepo, SETTING_KEYS } from "../../../src/db/settings";
import { buildReport, reportSnapshot, reportMarkdown } from "../../../src/owner/report/build";
import { DEFAULT_ACCENT } from "../../../src/owner/report/template";
import type { Env } from "../../../src/env";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...args: unknown[]) => generateTextMock(...args) }));
vi.mock("../../../src/llm/provider", () => ({
  createModel: () => ({ provider: "anthropic", modelId: "claude-haiku-test", model: {}, supportsPromptCache: true }),
  envKeyFor: () => undefined,
  fallbackModel: () => null,
}));

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let settings: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  settings = new SettingsRepo(db);
  env = { DB: d1, BUSINESS_NAME: "Hugo Hair", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
  generateTextMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("buildReport", () => {
  it("día vacío: no llama al modelo, usa el resumen fijo de 'día tranquilo'", async () => {
    const report = await buildReport(env, Date.now());
    expect(report.empty).toBe(true);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(report.model.insights.summary).toContain("Día tranquilo");
    expect(report.text).toContain("Día tranquilo");
  });

  it("día con actividad: sí llama al modelo para los insights", async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ summary: "Buen día", insights: [], actions: [] }) });
    const conv = await convs.getOrCreate("telegram", "u1", "Cliente");
    await msgs.append(conv.id, "user", "hola", { createdAt: Date.now() });
    const report = await buildReport(env, Date.now() + 100);
    expect(report.empty).toBe(false);
    expect(generateTextMock).toHaveBeenCalled();
    expect(report.model.insights.summary).toBe("Buen día");
  });

  it("sin report_accent/report_logo/report_template: usa los defaults", async () => {
    const report = await buildReport(env, Date.now());
    expect(report.model.accent).toBe(DEFAULT_ACCENT);
    expect(report.model.logoUrl).toBeNull();
    expect(report.html).toContain(DEFAULT_ACCENT);
  });

  it("con report_accent/report_logo configurados: los usa en el modelo y el HTML", async () => {
    await settings.set(SETTING_KEYS.reportAccent, "#ff0000");
    await settings.set(SETTING_KEYS.reportLogo, "https://x/logo.png");
    const report = await buildReport(env, Date.now());
    expect(report.model.accent).toBe("#ff0000");
    expect(report.model.logoUrl).toBe("https://x/logo.png");
    expect(report.html).toContain("#ff0000");
    expect(report.html).toContain("https://x/logo.png");
  });

  it("con report_template custom: el HTML sale con la plantilla del dueño, no la default", async () => {
    await settings.set(SETTING_KEYS.reportTemplate, "<html><body>MI PLANTILLA: {{BUSINESS_NAME}}</body></html>");
    const report = await buildReport(env, Date.now());
    expect(report.html).toContain("MI PLANTILLA: Hugo Hair");
  });

  it("el panelUrl apunta a /admin/report en el origin del bot", async () => {
    const report = await buildReport(env, Date.now());
    expect(report.model.panelUrl).toBe("https://bot.example/admin/report");
  });

  it("title y subject incluyen el nombre del negocio", async () => {
    const report = await buildReport(env, Date.now());
    expect(report.title).toContain("Hugo Hair");
    expect(report.subject).toContain("📊");
  });
});

describe("reportSnapshot / reportMarkdown", () => {
  it("el snapshot es serializable a JSON y trae stats + prev + topics", async () => {
    const report = await buildReport(env, Date.now());
    const now = Date.now();
    const snap = reportSnapshot(report, now);
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(snap.generated_at).toBe(now);
    expect(snap.period).toEqual({ from: now - 24 * 60 * 60 * 1000, to: now });
    expect(snap.stats).toHaveProperty("messages");
    expect(snap.stats).toHaveProperty("hot_leads");
  });

  it("reportMarkdown incluye negocio, resumen y KPIs en negritas markdown", async () => {
    const report = await buildReport(env, Date.now());
    const snap = reportSnapshot(report, Date.now());
    const md = reportMarkdown(snap, "Hugo Hair");
    expect(md).toContain("**Hugo Hair**");
    expect(md).toMatch(/\*\*\d+\*\* mensajes/);
  });

  it("reportMarkdown omite secciones vacías (insights/acciones/temas/preguntas)", async () => {
    const report = await buildReport(env, Date.now()); // día vacío → sin insights/acciones
    const snap = reportSnapshot(report, Date.now());
    const md = reportMarkdown(snap, "Hugo Hair");
    expect(md).not.toContain("**Lo que veo**");
    expect(md).not.toContain("**Para mañana**");
    expect(md).not.toContain("**Temas de hoy**");
  });
});
