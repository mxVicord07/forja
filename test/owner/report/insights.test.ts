import { describe, it, expect, vi, afterEach } from "vitest";
import { generateReportInsights } from "../../../src/owner/report/insights";
import type { ReportContext } from "../../../src/owner/report/collect";
import type { Env } from "../../../src/env";

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("../../../src/llm/provider", () => ({
  createModel: () => ({
    provider: "anthropic",
    modelId: "claude-haiku-test",
    model: {},
    supportsPromptCache: true,
  }),
  envKeyFor: () => undefined,
  fallbackModel: () => null,
}));

function makeCtx(over: Partial<ReportContext> = {}): ReportContext {
  return {
    stats: { customerMessages: 5, newConversations: 3, newLeads: 2, hotLeads: 1, ticketsOpened: 1, ticketsResolved: 0, upsetCustomers: 0 },
    prev: { customerMessages: 4, newConversations: 2, newLeads: 1, hotLeads: 0, ticketsOpened: 0, ticketsResolved: 0, upsetCustomers: 0 },
    resolutionRate: 80,
    analyzed: 5,
    sentiment: { contentos: 3, neutrales: 1, frustrados: 1, molestos: 0 },
    botRating: 4.2,
    hourly: new Array(24).fill(0),
    peakHour: 14,
    topics: [{ name: "precios", count: 3 }, { name: "horario", count: 2 }],
    missedQuestions: [],
    followupsSent: 0,
    reviewsRequested: 0,
    trend7: [1, 2, 3, 4, 5, 6, 7],
    trendDeltaPct: 10,
    summaries: ["Preguntó por precios"],
    hotLeadSummaries: ["Quiere comprar mañana"],
    ...over,
  };
}

const env = { DB: {} as any, BUSINESS_NAME: "Hugo Hair", ANTHROPIC_API_KEY: "sk-test" } as unknown as Env;

afterEach(() => {
  generateTextMock.mockReset();
});

describe("generateReportInsights", () => {
  it("manda los temas como texto legible en el prompt (no [object Object])", async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ summary: "s", insights: [], actions: [] }) });
    await generateReportInsights(env, makeCtx());

    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("TEMAS FRECUENTES HOY: precios, horario");
    expect(prompt).not.toContain("[object Object]");
  });

  it("parsea summary/insights/actions del JSON que devuelve el modelo", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        summary: "Buen día, subieron los leads.",
        insights: ["Los leads subieron 100% vs ayer"],
        actions: ["Da seguimiento a la venta caliente"],
      }),
    });
    const out = await generateReportInsights(env, makeCtx());
    expect(out.summary).toBe("Buen día, subieron los leads.");
    expect(out.insights).toEqual(["Los leads subieron 100% vs ayer"]);
    expect(out.actions).toEqual(["Da seguimiento a la venta caliente"]);
  });

  it("cae al fallback si el modelo no devuelve JSON válido", async () => {
    generateTextMock.mockResolvedValue({ text: "no es json" });
    const out = await generateReportInsights(env, makeCtx());
    expect(out.summary).toContain("5 mensajes de 3 clientes");
    expect(out.summary).toContain("2 leads");
  });

  it("cae al fallback si el modelo lanza", async () => {
    generateTextMock.mockRejectedValue(new Error("provider down"));
    const out = await generateReportInsights(env, makeCtx());
    expect(out.summary).toContain("mensajes");
  });

  it("fallback: menciona las ventas calientes sin cerrar cuando hotLeads > 0", async () => {
    generateTextMock.mockRejectedValue(new Error("x"));
    const out = await generateReportInsights(env, makeCtx({ stats: { customerMessages: 1, newConversations: 1, newLeads: 0, hotLeads: 2, ticketsOpened: 0, ticketsResolved: 0, upsetCustomers: 0 } }));
    expect(out.insights[0]).toContain("2 ventas");
  });

  it("sin temas ni ventas calientes, no manda esas secciones en el prompt", async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ summary: "s", insights: [], actions: [] }) });
    await generateReportInsights(env, makeCtx({ topics: [], hotLeadSummaries: [] }));
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("TEMAS FRECUENTES");
    expect(prompt).not.toContain("VENTAS CALIENTES");
  });
});
