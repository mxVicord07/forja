import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCrmFicha, renderCrmBlock, llevaVictor, noTocar, type CrmFicha } from "../../src/integrations/crmFicha";

const URL_FICHA = "https://n8n.example/webhook/forja-ficha-x";

const base: CrmFicha = {
  lead: {
    id: 91,
    titulo: "Do Corpo: sistema operativo clínico",
    tipo: "oportunidad",
    etapa_clave: "Proposition",
    etapa: "Propuesta",
    monto: 60500,
    etiquetas: ["Clínica"],
    empresa: "Do Corpo Rehabilitación Física",
    contacto: "Hugo Loredo",
    resumen_ultima_interaccion: "Pidió revisar la propuesta con su socio.",
    ultimo_contacto: "2026-10-21",
    proxima_actividad: { fecha: "2026-10-26", resumen: "Toque 2" },
  },
  cotizacion: { folio: "S00046", estado: "enviada", monto_sin_iva: 60500, vigencia: "2026-11-15" },
  interacciones: [{ fecha: "2026-10-21", canal: "whatsapp", direccion: "saliente", resumen: "Victor envió la propuesta.", documentos: null }],
};

afterEach(() => vi.restoreAllMocks());

describe("fetchCrmFicha", () => {
  const env = { CRM_FICHA_URL: URL_FICHA } as any;

  it("sin CRM_FICHA_URL no llama a nada", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await fetchCrmFicha({} as any, { conversationId: "c1", channel: "whatsapp", channelUserId: "524441796793" })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("en WhatsApp manda el teléfono y la conversación, y devuelve la ficha encontrada", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, encontrado: true, ...base })),
    );
    const out = await fetchCrmFicha(env, { conversationId: "c1", channel: "whatsapp", channelUserId: "524441796793" });
    expect(out?.lead.id).toBe(91);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ conversationId: "c1", channel: "whatsapp", phone: "524441796793" });
  });

  it("fuera de WhatsApp no manda el id del canal como teléfono", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, encontrado: false })));
    await fetchCrmFicha(env, { conversationId: "c1", channel: "telegram", channelUserId: "8500344545" });
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.phone).toBeUndefined();
  });

  it("devuelve null si no hay cliente en el CRM", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, encontrado: false })));
    expect(await fetchCrmFicha(env, { conversationId: "c1", channel: "whatsapp", channelUserId: "1" })).toBeNull();
  });

  it("es fail-soft: si n8n falla o tarda, devuelve null sin lanzar", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    expect(await fetchCrmFicha(env, { conversationId: "c1", channel: "whatsapp", channelUserId: "1" })).toBeNull();
  });
});

describe("renderCrmBlock", () => {
  it("da contexto y prohíbe revelar el registro interno", () => {
    const txt = renderCrmBlock(base);
    expect(txt).toContain("<crm>");
    expect(txt).toContain("Hugo Loredo");
    expect(txt).toContain("Pidió revisar la propuesta con su socio.");
    expect(txt).toMatch(/nunca menciones/i);
    // Datos internos que no deben llegar al modelo como algo para decir.
    expect(txt).not.toContain("Toque 2");
  });

  it("en Propuesta o Calificado manda a Victor cualquier negociación", () => {
    const txt = renderCrmBlock(base);
    expect(txt).toMatch(/descuento/i);
    expect(txt).toContain("handoffHuman");
  });

  it("con cotización enviada da folio y monto con IVA aparte", () => {
    expect(renderCrmBlock(base)).toContain("S00046 por $60,500 MXN + IVA");
  });

  it("con cotización en borrador no da el monto ni la trata como enviada", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, estado: "borrador (aún no enviada)" } });
    expect(txt).not.toContain("60,500");
    expect(txt).toMatch(/todavía no se le ha enviado/i);
  });

  it("el candado deja ofrecer alternativas a precio de lista sin tocar la propuesta (decisión D3, I-023)", () => {
    const txt = renderCrmBlock(base);
    expect(txt).toMatch(/precio de lista/i);
    expect(txt).not.toMatch(/ni des cifras nuevas/);
  });

  it("trae las indicaciones de Victor para LIA (brief) cuando existen", () => {
    const txt = renderCrmBlock({ ...base, lead: { ...base.lead, brief: "Le pesa el monto; explorar empezar solo por la agenda." } });
    expect(txt).toContain("Indicaciones de Victor para atender a este cliente: Le pesa el monto; explorar empezar solo por la agenda.");
  });

  it("sin brief no agrega la línea de indicaciones", () => {
    expect(renderCrmBlock(base)).not.toContain("Indicaciones de Victor");
    expect(renderCrmBlock({ ...base, lead: { ...base.lead, brief: "   " } })).not.toContain("Indicaciones de Victor");
  });

  it("en etapa Nuevo no impone la regla de negociación", () => {
    const txt = renderCrmBlock({ ...base, lead: { ...base.lead, etapa_clave: "New", etapa: "Nuevo" }, cotizacion: null });
    expect(txt).not.toContain("handoffHuman");
  });
});

describe("llevaVictor y noTocar", () => {
  const conEtapa = (etapa_clave: string | null): CrmFicha => ({ ...base, lead: { ...base.lead, etapa_clave } });
  const conSemaforo = (codigo: string | null): CrmFicha => ({ ...base, semaforo: codigo ? { codigo, texto: null, siguiente_toque: null } : null });

  it("llevaVictor entiende la clave técnica y también los nombres en español que Victor puso en Odoo", () => {
    for (const e of ["Qualified", "Proposition", "Won", "Calificado", "Pre-Calificados", "Propuesta", "Ganado"]) expect(llevaVictor(conEtapa(e))).toBe(true);
    for (const e of ["New", "Seguimiento", "Nuevos Leads", null]) expect(llevaVictor(conEtapa(e))).toBe(false);
  });

  it("noTocar solo se activa con los códigos de ganado, no contactar y pausa", () => {
    for (const c of ["no_tocar:ganado", "no_tocar:no_contactar", "esperar:pausa"]) expect(noTocar(conSemaforo(c))).toBe(true);
    for (const c of ["esperar:contacto_reciente", "tocar:retomar", "victor:calificado", null]) expect(noTocar(conSemaforo(c))).toBe(false);
    expect(noTocar(base)).toBe(false); // ficha sin semáforo: todo sigue como antes
  });

  it("fetchCrmFicha conserva el semáforo que trae la ficha", async () => {
    const semaforo = { codigo: "no_tocar:ganado", texto: "No tocar · Ganado: ya es cliente", siguiente_toque: null };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, encontrado: true, ...base, semaforo })));
    const f = await fetchCrmFicha({ CRM_FICHA_URL: URL_FICHA } as any, { conversationId: "c1", channel: "web", channelUserId: "u" });
    expect(f?.semaforo).toEqual(semaforo);
  });
});
