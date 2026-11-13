import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import {
  normalizeContexto, variantesTelefono, limpiarBorrador, contextoTexto, systemPrompt, redactarBorrador,
  borradoresVigentes, hiloDe, __resetBorradorIa,
} from "../../src/crm/borradorIa";
import { Db } from "../../src/db/client";
import { renderSeguimientoBlock } from "../../src/admin/views/seguimiento";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => __resetBorradorIa());

const ctxResp = (over: Record<string, unknown> = {}) => ({
  ok: true,
  lead: { id: 92, tipo: "oportunidad", titulo: "SASU: sitio web", quien: "Marcos", empresa: "SASU", etapa: "Por firmar", codigo: "victor:propuesta", conversacion: null, descripcion: "Quiere el sitio bilingüe" },
  actividades: [{ fecha: "2026-11-10", tipo: "Llamada", resumen: "Confirmar fecha de arranque", nota: null }],
  notas: [{ fecha: "2026-11-08", autor: "Victor", texto: "Le mandé la propuesta v0.3; dijo que la revisa con su socio." }],
  huella_odoo: "2026-11-12 10:00:00",
  ...over,
});
const env = (d1: any, over: Record<string, unknown> = {}) => ({ DB: d1, CRM_SEGUIMIENTO_URL: "https://n8n.x/webhook/forja-seguimiento-1", FEATURE_BORRADOR_IA: "1", DUENO_NOMBRE: "Víctor", BUSINESS_NAME: "BIRevX", BOT_TIER: "pro", BOT_LANGUAGE: "es", ...over }) as any;

async function d1ConChat() {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const t = Date.parse("2026-11-12T18:00:00Z");
  await d1.prepare("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES ('c1', 'whatsapp', '5214441112233', 'Marcos', ?, ?)").bind(t, t).run();
  await d1.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1','c1','owner','Marcos, ¿la pudiste ver con tu socio?', ?)").bind(t - 7_200_000).run();
  await d1.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m2','c1','user','Todavía no, el lunes te digo', ?)").bind(t).run();
  return d1;
}

describe("piezas puras", () => {
  it("normaliza el contexto y rechaza respuestas sin ok", () => {
    expect(normalizeContexto({ ok: false })).toBeNull();
    const c = normalizeContexto(ctxResp())!;
    expect(c.lead.quien).toBe("Marcos");
    expect(c.huellaOdoo).toBe("2026-11-12 10:00:00");
    expect(c.notas).toHaveLength(1);
  });
  it("encuentra el número con y sin el 1 de México", () => {
    expect(variantesTelefono("https://wa.me/524441112233").sort()).toEqual(["5214441112233", "524441112233"]);
    expect(variantesTelefono(null)).toEqual([]);
  });
  it("limpia comillas, respeta NO_ESCRIBIR y corta lo largo", () => {
    expect(limpiarBorrador('"Hola Marcos"')).toBe("Hola Marcos");
    expect(limpiarBorrador("NO_ESCRIBIR")).toBeNull();
    expect(limpiarBorrador("palabra ".repeat(200))!.length).toBeLessThanOrEqual(702);
  });
  it("el prompt prohíbe precios e inventos y escribe como el dueño", () => {
    const p = systemPrompt(env(null));
    expect(p).toContain("como Víctor");
    expect(p).toMatch(/No menciones precios/);
  });
  it("el contexto lleva chatter, pendientes y el chat con quién dijo qué", async () => {
    const d1 = await d1ConChat();
    const hilo = await hiloDe(new Db(d1), null, "https://wa.me/524441112233");
    const t = contextoTexto(normalizeContexto(ctxResp())!, hilo, "jueves 13 de noviembre de 2026", "America/Mexico_City");
    expect(t).toContain("dijo que la revisa con su socio");
    expect(t).toContain("Confirmar fecha de arranque");
    expect(t).toContain("Yo (desde mi app): Marcos, ¿la pudiste ver con tu socio?");
    expect(t).toContain("Cliente: Todavía no, el lunes te digo");
  });
});

describe("redactarBorrador y vigencia", () => {
  it("apagado sin la bandera, sin llamar a la red", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    expect(await redactarBorrador(env(null, { FEATURE_BORRADOR_IA: undefined }), 92, null)).toEqual({ ok: false, motivo: "apagado" });
    expect(f).not.toHaveBeenCalled();
  });

  it("redacta con el contexto, guarda con huella y deja de valer cuando llega un mensaje nuevo", async () => {
    const d1 = await d1ConChat();
    const f = vi.fn(async (_u: any, init: any) => {
      expect(JSON.parse(init.body)).toEqual({ contexto: 92 });
      return new Response(JSON.stringify(ctxResp()), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    let visto = "";
    const generar = async (_s: string, prompt: string) => { visto = prompt; return { text: "«Hola Marcos, ¿cómo les fue con tu socio?»", modelo: "test-model" }; };
    const now = new Date("2026-11-13T15:00:00Z");
    const r = await redactarBorrador(env(d1), 92, "https://wa.me/524441112233", { now, generar });
    expect(r.ok).toBe(true);
    expect(visto).toContain("el lunes te digo");
    if (r.ok) expect(r.borrador.texto).toBe("Hola Marcos, ¿cómo les fue con tu socio?");

    const fila = { id: 92, huellaOdoo: "2026-11-12 10:00:00", conversacion: null, waPropio: "https://wa.me/524441112233" };
    const db = new Db(d1);
    expect((await borradoresVigentes(db, [fila], now.getTime())).get(92)?.texto).toContain("Marcos");
    // Cambió la oportunidad en Odoo → ya no vale.
    expect((await borradoresVigentes(db, [{ ...fila, huellaOdoo: "2026-11-13 09:00:00" }], now.getTime())).size).toBe(0);
    // Pasaron más de 72 h → ya no vale.
    expect((await borradoresVigentes(db, [fila], now.getTime() + 73 * 3_600_000)).size).toBe(0);
    // Llegó un mensaje nuevo → ya no vale.
    await d1.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m3','c1','user','Ya la vimos, adelante', ?)").bind(now.getTime() + 1000).run();
    expect((await borradoresVigentes(db, [fila], now.getTime() + 2000)).size).toBe(0);
  });

  it("no redacta para quien pidió no ser contactado ni si el modelo dice NO_ESCRIBIR", async () => {
    const d1 = await d1ConChat();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ctxResp({ lead: { ...ctxResp().lead, codigo: "no_tocar:baja" } })), { status: 200 })));
    const generar = vi.fn();
    expect(await redactarBorrador(env(d1), 92, null, { generar })).toEqual({ ok: false, motivo: "no_escribir" });
    expect(generar).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ctxResp()), { status: 200 })));
    expect(await redactarBorrador(env(d1), 92, null, { generar: async () => ({ text: "NO_ESCRIBIR", modelo: "m" }) })).toEqual({ ok: false, motivo: "no_escribir" });
    expect(await redactarBorrador(env(d1), 92, null, { generar: async () => { throw new Error("x"); } })).toEqual({ ok: false, motivo: "llm_failed" });
  });
});

describe("tarjeta con borrador con IA", () => {
  const panel = (over: Record<string, unknown> = {}) => ({
    ok: true, generado: "2026-11-13T15:00:00Z",
    resumen: { etapas: [], prospectos: 0, oportunidades: 1, tocar_hoy: 0, sin_actividad: 1, actividad_vencida: 0 },
    filas: [{ id: 92, tipo: "oportunidad", titulo: "SASU: sitio web", quien: "Marcos", etapa: "Por firmar", codigo: "victor:propuesta", actividad: null, huella_odoo: "2026-11-12 10:00:00",
      wa_propio: "https://wa.me/524441112233", sugerido: { tipo: "borrador", texto: "Hola Marcos, soy Víctor de BIRevX.", wa_url: "https://wa.me/524441112233?text=Hola", permitido: true }, ...over }],
  });

  it("sin borrador guardado muestra el texto fijo y el botón para redactar; con borrador vigente lo usa en el enlace", async () => {
    const d1 = await d1ConChat();
    const now = new Date("2026-11-13T15:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(panel()), { status: 200 })));
    let html = await renderSeguimientoBlock(env(d1), now);
    expect(html).toContain("✨ Redactar con su historial");
    expect(html).toContain('action="/admin/leads/odoo/92/borrador-ia"');
    expect(html).toContain("Borrador para que lo edites y lo mandes tú");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ctxResp()), { status: 200 })));
    await redactarBorrador(env(d1), 92, "https://wa.me/524441112233", { now, generar: async () => ({ text: "Hola Marcos, ¿cómo les fue con tu socio?", modelo: "m" }) });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(panel()), { status: 200 })));
    html = await renderSeguimientoBlock(env(d1), now);
    expect(html).toContain("Borrador con su historial (IA");
    expect(html).toContain("✨ Redactar de nuevo");
    expect(html).toContain("wa.me/524441112233?text=" + encodeURIComponent("Hola Marcos, ¿cómo les fue con tu socio?"));
  });

  it("sin permiso de WhatsApp no ofrece redactar ni usa el borrador", async () => {
    const d1 = await d1ConChat();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(panel({ sugerido: { tipo: "plantilla", texto: "x", wa_url: null, permitido: false, motivo: "Sin consentimiento vigente" } })), { status: 200 })));
    const html = await renderSeguimientoBlock(env(d1), new Date("2026-11-13T15:00:00Z"));
    expect(html).not.toContain("Redactar con su historial");
    expect(html).toContain("Sin consentimiento vigente");
  });

  it("con la bandera apagada no aparece el botón", async () => {
    const d1 = await d1ConChat();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(panel()), { status: 200 })));
    const html = await renderSeguimientoBlock(env(d1, { FEATURE_BORRADOR_IA: undefined }), new Date("2026-11-13T15:00:00Z"));
    expect(html).not.toContain("Redactar con su historial");
  });

  it("muestra el aviso cuando la redacción falló", async () => {
    const d1 = await d1ConChat();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(panel()), { status: 200 })));
    const html = await renderSeguimientoBlock(env(d1), new Date("2026-11-13T15:00:00Z"), "llm_failed");
    expect(html).toContain("El modelo de IA no respondió");
  });
});
