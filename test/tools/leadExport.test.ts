import { describe, it, expect, vi, afterEach } from "vitest";
import { parseContactInfo, pushConversationSummary } from "../../src/tools/leadExport";

describe("parseContactInfo", () => {
  it("caso real de producción: teléfono y email juntos con '/' — no corrompe el teléfono con dígitos del correo", () => {
    const result = parseContactInfo("4447029227 / manuel_pl3@hotmail.com");
    expect(result.phone).toBe("4447029227");
    expect(result.email).toBe("manuel_pl3@hotmail.com");
  });

  it("alias de Instagram junto a teléfono", () => {
    const result = parseContactInfo("@mi_negocio_ig, tel 5551234567");
    expect(result.phone).toBe("5551234567");
    expect(result.otherContact).toBe("@mi_negocio_ig");
  });

  it("solo email", () => {
    const result = parseContactInfo("cliente@ejemplo.com");
    expect(result).toEqual({ email: "cliente@ejemplo.com" });
  });

  it("correo con dominio de más de una etiqueta (.com.mx) no se trunca", () => {
    const result = parseContactInfo("juan@empresa.com.mx");
    expect(result.email).toBe("juan@empresa.com.mx");
    expect(result.otherContact).toBeUndefined();
  });

  it("frase natural en español no ensucia otherContact con texto suelto", () => {
    const result = parseContactInfo("mi whats es 5551234567 y mi correo perro@gmail.com");
    expect(result.phone).toBe("5551234567");
    expect(result.email).toBe("perro@gmail.com");
    expect(result.otherContact).toBeUndefined();
  });

  it("solo teléfono", () => {
    const result = parseContactInfo("+52 155 1234 5678");
    expect(result.phone).toBe("5215512345678");
    expect(result.email).toBeUndefined();
  });

  it("string vacío o undefined → objeto vacío", () => {
    expect(parseContactInfo(undefined)).toEqual({});
    expect(parseContactInfo("")).toEqual({});
    expect(parseContactInfo("   ")).toEqual({});
  });

  it("solo alias de red social, sin teléfono ni email", () => {
    const result = parseContactInfo("en instagram soy @tal_negocio");
    expect(result.phone).toBeUndefined();
    expect(result.email).toBeUndefined();
    expect(result.otherContact).toBe("@tal_negocio");
  });
});

describe("pushConversationSummary", () => {
  const URL_UPSERT = "https://n8n.example/webhook/forja-lead-upsert";
  const base = {
    conversationId: "conv-1",
    channel: "whatsapp",
    channelUserId: "524441796793",
    summary: "Preguntó precios del asistente para su clínica; Victor tomó la conversación.",
    topics: ["precios"],
    saleOpportunity: true,
    lastMessageAt: Date.UTC(2026, 9, 30, 21, 53),
  };

  afterEach(() => vi.restoreAllMocks());

  it("sin webhook configurado no llama a nada", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await pushConversationSummary({} as any, base)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("manda kind resumen con el teléfono en WhatsApp y la fecha del último mensaje", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, accion: "resumen" })));
    expect(await pushConversationSummary({ LEAD_EXPORT_WEBHOOK_URL: URL_UPSERT } as any, base)).toBe(true);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      kind: "resumen",
      conversationId: "conv-1",
      channel: "whatsapp",
      phone: "524441796793",
      summary: base.summary,
      topics: ["precios"],
      saleOpportunity: true,
      lastMessageAt: "2026-10-30T21:53:00.000Z",
    });
  });

  it("fuera de WhatsApp no manda el id del canal como teléfono", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await pushConversationSummary({ LEAD_EXPORT_WEBHOOK_URL: URL_UPSERT } as any, { ...base, channel: "telegram" });
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.phone).toBeUndefined();
  });

  it("es fail-soft: si n8n falla devuelve false sin lanzar", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    expect(await pushConversationSummary({ LEAD_EXPORT_WEBHOOK_URL: URL_UPSERT } as any, base)).toBe(false);
  });
});
