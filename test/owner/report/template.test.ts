import { describe, it, expect } from "vitest";
import {
  renderReportHtml,
  renderReportEmail,
  renderReportText,
  DEFAULT_ACCENT,
  DEFAULT_REPORT_TEMPLATE,
  type ReportModel,
} from "../../../src/owner/report/template";
import type { ReportContext } from "../../../src/owner/report/collect";

function makeModel(over: Partial<ReportModel> = {}): ReportModel {
  const ctx: ReportContext = {
    stats: { customerMessages: 5, newConversations: 3, newLeads: 2, hotLeads: 1, ticketsOpened: 2, ticketsResolved: 1, upsetCustomers: 1 },
    prev: { customerMessages: 4, newConversations: 2, newLeads: 1, hotLeads: 0, ticketsOpened: 1, ticketsResolved: 1, upsetCustomers: 0 },
    resolutionRate: 75,
    analyzed: 4,
    sentiment: { contentos: 2, neutrales: 1, frustrados: 0, molestos: 1 },
    botRating: 4.5,
    hourly: new Array(24).fill(0),
    peakHour: 10,
    topics: [{ name: "precios", count: 3 }],
    missedQuestions: ["¿hacen envíos?"],
    followupsSent: 2,
    reviewsRequested: 1,
    trend7: [1, 2, 3, 4, 5, 6, 7],
    trendDeltaPct: 15,
    summaries: [],
    hotLeadSummaries: [],
  };
  return {
    businessName: "Hugo Hair",
    dateLabel: "lunes, 1 de septiembre",
    accent: DEFAULT_ACCENT,
    logoUrl: null,
    panelUrl: "https://bot.example/admin/report",
    ctx,
    insights: { summary: "Buen día para el negocio.", insights: ["Subieron los leads"], actions: ["Sigue así"] },
    ...over,
  };
}

describe("renderReportHtml", () => {
  it("reemplaza todos los placeholders (ninguno queda sin llenar)", () => {
    const html = renderReportHtml(makeModel());
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  it("escapa HTML en textos de negocio (XSS del dueño hacia sí mismo, defensa en profundidad)", () => {
    const html = renderReportHtml(makeModel({ businessName: '<script>alert(1)</script>' }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("usa el logo si hay logoUrl, si no un monograma con iniciales", () => {
    const withLogo = renderReportHtml(makeModel({ logoUrl: "https://x/logo.png" }));
    expect(withLogo).toContain('src="https://x/logo.png"');

    const withoutLogo = renderReportHtml(makeModel({ logoUrl: null, businessName: "Hugo Hair" }));
    expect(withoutLogo).toContain("HH"); // iniciales
  });

  it("acepta una plantilla custom del dueño (mismos placeholders, diseño distinto)", () => {
    const custom = `<html><body>{{BUSINESS_NAME}} — {{SUMMARY}}</body></html>`;
    const html = renderReportHtml(makeModel(), custom);
    expect(html).toContain("Hugo Hair — Buen día para el negocio.");
    expect(html).not.toContain(DEFAULT_REPORT_TEMPLATE.slice(0, 50)); // no usó la default
  });

  it("sin insights ni acciones: cae a los textos por default, no deja huecos vacíos", () => {
    const html = renderReportHtml(makeModel({ insights: { summary: "Día normal.", insights: [], actions: [] } }));
    expect(html).toContain("Sin hallazgos que resaltar hoy.");
    expect(html).toContain("Mantén el ritmo — nada urgente para mañana.");
  });

  it("sin preguntas sin responder: muestra el mensaje positivo, no una lista vacía", () => {
    const html = renderReportHtml(makeModel({ ctx: { ...makeModel().ctx, missedQuestions: [] } }));
    expect(html).toContain("respondió todo lo que le preguntaron");
  });
});

describe("renderReportEmail", () => {
  it("incluye el link al reporte completo y hasta 3 insights", () => {
    const html = renderReportEmail(
      makeModel({ insights: { summary: "s", insights: ["a", "b", "c", "d"], actions: [] } }),
    );
    expect(html).toContain('href="https://bot.example/admin/report"');
    expect((html.match(/<li/g) ?? []).length).toBe(3); // recorta a 3
  });

  it("es un documento HTML autocontenido (doctype propio)", () => {
    const html = renderReportEmail(makeModel());
    expect(html).toMatch(/^<!doctype html>/i);
  });
});

describe("renderReportText", () => {
  it("incluye negocio, resumen, números clave y el link", () => {
    const text = renderReportText(makeModel());
    expect(text).toContain("Hugo Hair — lunes, 1 de septiembre");
    expect(text).toContain("Buen día para el negocio.");
    expect(text).toContain("5 mensajes · 3 clientes · 2 leads · 1 ventas calientes");
    expect(text).toContain("Reporte completo: https://bot.example/admin/report");
  });

  it("incluye insights y acciones con sus viñetas", () => {
    const text = renderReportText(makeModel());
    expect(text).toContain("Lo que veo:");
    expect(text).toContain("• Subieron los leads");
    expect(text).toContain("Para mañana:");
    expect(text).toContain("→ Sigue así");
  });

  it("sin insights/acciones, omite esas secciones (no deja encabezados vacíos)", () => {
    const text = renderReportText(makeModel({ insights: { summary: "s", insights: [], actions: [] } }));
    expect(text).not.toContain("Lo que veo:");
    expect(text).not.toContain("Para mañana:");
  });
});
