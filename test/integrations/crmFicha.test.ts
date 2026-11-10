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

describe("renderCrmBlock · propuesta vigente (I-023)", () => {
  const detalle = {
    referencia: "Propuesta v1.2 · 2026-10-28",
    monto_total: 70180,
    anticipo_pct: 30,
    firmada: false,
    lineas: [
      { descripcion: "Sistema operativo clínico", subtotal: 60500 },
      { descripcion: "Beneficio por primer proyecto", subtotal: -4000 },
    ],
    enlace: "https://odoo.birevx.com/my/orders/46?access_token=tok",
  };

  it("con la propuesta enviada trae versión, total, anticipo, qué incluye y el enlace", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, ...detalle } });
    expect(txt).toContain("S00046 (Propuesta v1.2 · 2026-10-28)");
    expect(txt).toContain("Total con IVA $70,180 MXN; anticipo de 30% = $21,054 MXN");
    expect(txt).toContain("Sistema operativo clínico ($60,500 MXN); Beneficio por primer proyecto (-$4,000 MXN)");
    expect(txt).toContain("https://odoo.birevx.com/my/orders/46?access_token=tok");
    expect(txt).toContain("nunca otro enlace ni uno inventado");
  });

  it("muestra los centavos cuando los hay y no redondea el total", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, monto_sin_iva: 18890, ...detalle, monto_total: 21912.4, anticipo_pct: 50, lineas: [{ descripcion: "Prueba", subtotal: 20 }] } });
    expect(txt).toContain("Total con IVA $21,912.40 MXN; anticipo de 50% = $10,956.20 MXN");
    expect(txt).toContain("por $18,890 MXN + IVA");
  });

  it("si ya firmó y pagó el anticipo lo dice y no habla de pagar otra vez", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, estado: "confirmada", ...detalle, firmada: true, firmada_el: "2026-11-03", anticipo_pagado: true } });
    expect(txt).toContain("ya aceptó, firmó el 2026-11-03 y pagó el anticipo");
    expect(txt).toContain("arranque del proyecto");
    expect(txt).not.toContain("lo que sigue es el anticipo");
    expect(txt).not.toContain("access_token");
  });

  it("sin enlace en la ficha no inventa uno", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, ...detalle, enlace: null } });
    expect(txt).not.toContain("Enlace de la propuesta");
    expect(txt).not.toContain("access_token");
  });

  it("si ya firmó no la ofrece otra vez ni da el enlace", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, estado: "confirmada", ...detalle, firmada: true, firmada_el: "2026-10-26" } });
    expect(txt).toContain("ya aceptó y firmó esta propuesta el 2026-10-26");
    expect(txt).not.toContain("access_token");
  });

  it("una propuesta en borrador no revela montos, líneas ni enlace aunque la ficha los traiga", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, estado: "borrador (aún no enviada)", ...detalle } });
    expect(txt).toContain("todavía no se le ha enviado");
    expect(txt).not.toContain("70,180");
    expect(txt).not.toContain("Sistema operativo clínico");
    expect(txt).not.toContain("access_token");
  });

  it("una propuesta en dólares, sin IVA y solo con firma se dice así: sin pesos, sin IVA y sin anticipo (Get Smoked)", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { folio: "S00056", estado: "enviada", monto_sin_iva: 1000, vigencia: "2026-11-23", referencia: "Propuesta v1.0 · 2026-11-08",
      monto_total: 1000, anticipo_pct: 100, firmada: false, moneda: "USD", sin_iva: true, cobro_en_linea: false,
      lineas: [{ descripcion: "Creación del sitio web", subtotal: 1235.96 }, { descripcion: "Ajuste preferencial", subtotal: -235.96 }], enlace: "https://odoo.birevx.com/es/my/orders/56?access_token=tok" } });
    expect(txt).toContain("S00056 (Propuesta v1.0 · 2026-11-08) por USD 1,000.00 (sin IVA), vigente hasta 2026-11-23");
    expect(txt).toContain("Importes en USD, sin IVA añadido");
    expect(txt).toContain("no hay cobro en línea ni anticipo");
    expect(txt).toContain("Creación del sitio web (USD 1,235.96); Ajuste preferencial (-USD 235.96)");
    expect(txt).not.toContain("MXN");
    expect(txt).not.toContain("anticipo de 100%");
  });

  it("con moneda y cobro sin dato (ficha anterior al 9-nov-2026) se ve en pesos, con IVA y con anticipo, como antes", () => {
    const txt = renderCrmBlock({ ...base, cotizacion: { ...base.cotizacion!, ...detalle } });
    expect(txt).toContain("por $60,500 MXN + IVA");
    expect(txt).toContain("anticipo de 30%");
  });

  it("una ficha anterior, sin detalle, se ve como antes", () => {
    const txt = renderCrmBlock(base);
    expect(txt).toContain("Propuesta enviada: S00046 por $60,500 MXN + IVA, vigente hasta 2026-11-15");
    expect(txt).not.toContain("anticipo");
  });
});

describe("renderCrmBlock · varios contactos de una empresa", () => {
  it("si escribe otro contacto de la empresa, lo dice y mantiene la misma propuesta", () => {
    const txt = renderCrmBlock({ ...base, lead: { ...base.lead, contacto_que_escribe: "Florencio Castillo" } });
    expect(txt).toContain("Quien te escribe ahora es Florencio Castillo, otro contacto de la misma empresa");
    expect(txt).toContain("S00046");
  });

  it("si escribe el contacto principal o la ficha no lo trae, no agrega nada", () => {
    expect(renderCrmBlock({ ...base, lead: { ...base.lead, contacto_que_escribe: "Hugo Loredo" } })).not.toContain("Quien te escribe ahora");
    expect(renderCrmBlock(base)).not.toContain("Quien te escribe ahora");
  });
});

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

describe("renderCrmBlock · reunión ya agendada (I-050)", () => {
  const conReunion = (r: NonNullable<CrmFicha["lead"]["proxima_reunion"]>): CrmFicha => ({ ...base, lead: { ...base.lead, proxima_reunion: r } });

  it("con una reunión acordada dice cuándo y dónde, y prohíbe negociar otro horario", () => {
    const txt = renderCrmBlock(conReunion({ cuando: "miércoles 11/11 a las 09:00", duracion_min: 60, lugar: "Oficinas de SASU", origen: "odoo" }));
    expect(txt).toContain("Reunión ya agendada con Victor: miércoles 11/11 a las 09:00 (60 min), en Oficinas de SASU");
    expect(txt).toContain("no propongas ni negocies otro horario");
    expect(txt).toContain("avisa a Victor");
  });

  it("una reserva de Cal.com sin lugar dice que es por Teams", () => {
    const txt = renderCrmBlock(conReunion({ cuando: "sábado 14/11 a las 11:00", duracion_min: 50, origen: "cal.com" }));
    expect(txt).toContain("sábado 14/11 a las 11:00 (50 min), por Teams");
  });

  it("sin reunión (o ficha anterior) no agrega la línea", () => {
    expect(renderCrmBlock(base)).not.toContain("Reunión ya agendada");
    expect(renderCrmBlock({ ...base, lead: { ...base.lead, proxima_reunion: null } })).not.toContain("Reunión ya agendada");
  });

  it("la reunión acordada convive con la regla del enlace de reserva: no se ofrece otro horario", () => {
    const txt = renderCrmBlock(conReunion({ cuando: "lunes 16/11 a las 10:00", origen: "odoo" }), { bookingUrl: "https://cal.com/birevx/ideas-exchange" });
    expect(txt).toContain("Reunión ya agendada con Victor: lunes 16/11 a las 10:00");
    expect(txt).toContain("Si ya hay una reunión acordada con Victor, no agendes otra");
  });
});

describe("renderCrmBlock · enlace de reserva de Cal.com", () => {
  it("con enlace configurado, le dice a Lía que lo ofrezca en vez de negociar horarios y que no agende otra reunión si ya hay una acordada", () => {
    const txt = renderCrmBlock(base, { bookingUrl: "https://cal.com/birevx/ideas-exchange" });
    expect(txt).toContain("quiere reunirse, tener una llamada o una videollamada con Victor");
    expect(txt).toContain("https://cal.com/birevx/ideas-exchange");
    expect(txt).toContain("no negocies horarios por mensaje");
    expect(txt).toContain("Si ya hay una reunión acordada con Victor, no agendes otra");
  });

  it("sin enlace configurado (o vacío) no agrega la regla", () => {
    expect(renderCrmBlock(base)).not.toContain("cal.com");
    expect(renderCrmBlock(base, { bookingUrl: "  " })).not.toContain("videollamada");
    expect(renderCrmBlock(base, {})).not.toContain("videollamada");
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
