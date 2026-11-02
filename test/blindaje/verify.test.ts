/**
 * Tests del Blindaje anti-invento (verificador pre-envío, Pro):
 *  • supported → sale la respuesta original
 *  • unsupported → respuesta segura "déjame confirmarlo" + ticket + aviso
 *  • verificador truena/timeout → FAIL-OPEN (sale la original intacta)
 *  • tier free → no se verifica nada
 *  • respuesta sin datos y sin KB → no se llama al verificador
 * LLM mockeado (como test/followup/run.test.ts); D1 real vía miniflare.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  tool: (def: unknown) => def,
}));

vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({
    provider: "anthropic",
    modelId: "modelo-test",
    model: {},
    supportsPromptCache: true,
  }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { TicketsRepo } from "../../src/db/tickets";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { shouldVerify, safeConfirmReply, guardReply, esRespuestaSegura } from "../../src/blindaje/verify";
import type { SearchKbResult } from "../../src/tools/searchKb";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
let convId: string;
let settings: SettingsRepo;
let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const KB_PASSAGES: SearchKbResult[] = [
  { title: "Precios", content: "Corte de cabello: $150. Corte + barba: $220.", score: 0.91 },
  { title: "Horarios", content: "Abrimos de martes a sábado, 10am a 7pm.", score: 0.84 },
];

function verdict(supported: boolean, claim?: string) {
  return {
    text: JSON.stringify({ supported, ...(claim ? { unsupported_claim: claim } : {}) }),
  };
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  settings = new SettingsRepo(db);
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1", "Cliente");
  convId = conv.id;
  env = {
    DB: d1,
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Hugo Hair",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    DASHBOARD_BASE_URL: "https://dash.test",
    // Canal de aviso al dueño (Telegram) — para verificar el reuso de notifyOwner.
    TELEGRAM_BOT_TOKEN: "tg-test-token",
    OWNER_TELEGRAM_CHAT_ID: "12345",
  } as unknown as Env;
  generateTextMock.mockReset();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("shouldVerify — heurística barata", () => {
  it("dispara con dígitos, moneda, porcentajes o palabras de dinero", () => {
    expect(shouldVerify("El corte cuesta $150", false)).toBe(true);
    expect(shouldVerify("Cuesta 150 pesos", false)).toBe(true);
    expect(shouldVerify("Tenemos 20% de descuento", false)).toBe(true);
    expect(shouldVerify("Son quinientos dólares", false)).toBe(true);
    expect(shouldVerify("¡Hoy es gratis!", false)).toBe(true);
  });

  it("dispara siempre que searchKb corrió este turno", () => {
    expect(shouldVerify("Claro, con gusto te explico", true)).toBe(true);
  });

  it("NO dispara con cortesía sin datos y sin KB", () => {
    expect(shouldVerify("¡Hola! Claro que sí, con gusto te ayudo.", false)).toBe(false);
    expect(shouldVerify("¿Me repites tu nombre, porfa?", false)).toBe(false);
  });
});

describe("guardReply — veredictos", () => {
  it("supported → manda la respuesta ORIGINAL y cuenta la verificación", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    const original = "El corte cuesta $150 y abrimos a las 10am.";

    const r = await guardReply(env, {
      replyText: original,
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      businessContext: "Corte: $150",
      conversationId: convId,
    });

    expect(r.action).toBe("sent-original");
    expect(r.finalText).toBe(original);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Corte de cabello: $150");
    expect(prompt).toContain(original);
  });

  it("el system prompt (persona) cuenta como fuente oficial en el prompt del verificador", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    await guardReply(env, {
      replyText: "La masterclass es GRATIS y es el domingo 26 de julio.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      systemPrompt: "Eres el bot. La masterclass del 26 de julio es GRATIS (valor 149 USD).",
      conversationId: convId,
    });
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("instrucciones_oficiales_del_bot");
    expect(prompt).toContain("26 de julio es GRATIS");
    expect(await new TicketsRepo(db).listOpen()).toHaveLength(0);
    expect(await settings.get(SETTING_KEYS.blindajeChecks)).toBe("1");
    expect(await settings.get(SETTING_KEYS.blindajeBlocked)).toBeNull();
  });

  it("el registro del cliente (ficha de Odoo, Brief, lo que escribió el dueño) cuenta como fuente oficial", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    await guardReply(env, {
      replyText: "La propuesta es de $17,500 más $3,500 al mes, más IVA.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      extraSources: "Propuesta enviada: S00099 por $17,500 MXN + IVA",
      conversationId: convId,
    });
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("registro_del_cliente");
    expect(prompt).toContain("S00099 por $17,500");
    // el precio que el dueño le dio a ese cliente prevalece sobre un "desde" genérico de la KB
    expect(prompt).toMatch(/prevalec/i);
  });

  it("en relevo, el reemplazo no habla de 'el equipo': dice que lo confirma quien lo atendió", async () => {
    generateTextMock.mockResolvedValue(verdict(false, "paquete básico"));
    const r = await guardReply(env, {
      replyText: "Puedes empezar con un automático básico de $9,000.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      relevo: true,
      conversationId: convId,
    });
    expect(r.action).toBe("replaced");
    expect(r.finalText).toBe(safeConfirmReply("es", { relevo: true }));
    expect(r.finalText).toMatch(/quien te atendi/i);
    expect(r.finalText).not.toMatch(/el equipo/i);
    expect(await new TicketsRepo(db).listOpen()).toHaveLength(1);
  });

  it("el verificador consulta la KB por su cuenta con la respuesta: no depende de que el bot haya usado searchKb", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    const envConKb = {
      ...env,
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      KB: {
        query: vi.fn(async () => ({
          matches: [
            { score: 0.82, metadata: { title: "Opciones para arrancar", content: "Pago de la implementación en 3 pagos iguales sin recargo." } },
            { score: 0.2, metadata: { title: "Ruido", content: "Texto sin relación" } },
          ],
        })),
      },
    } as unknown as Env;

    await guardReply(envConKb, {
      replyText: "Puedes pagar la implementación en 3 pagos iguales.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      conversationId: convId,
    });

    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Pago de la implementación en 3 pagos iguales sin recargo.");
    expect(prompt).not.toContain("Texto sin relación");
  });

  it("A: omitir 'más IVA' o 'desde' no es dato sin respaldo, y lo que dijo el cliente va como fuente para sus propias cuentas", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    await guardReply(env, {
      replyText: "Con tu ticket de $400 hacen falta unas 9 citas extra al mes.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      mensajesCliente: "nuestro ticket promedio de consulta es de $400 MXN",
      conversationId: convId,
    });
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("lo_que_dijo_el_cliente");
    expect(prompt).toContain("ticket promedio de consulta es de $400");
    expect(prompt).toMatch(/omitir "más IVA" o "desde"/i);
    expect(prompt).toMatch(/cuentas aritméticas/i);
  });

  it("B: con siempre=true se verifica aunque la respuesta no traiga cifras ni haya usado la KB", async () => {
    generateTextMock.mockResolvedValue(verdict(false, "se aprovecha lo ya pagado"));
    const r = await guardReply(env, {
      replyText: "No pagas todo de nuevo: se aprovecha lo que ya está listo.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      siempre: true,
      relevo: true,
      conversationId: convId,
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(r.action).toBe("replaced");
  });

  it("reintentable: un rechazo no reemplaza ni abre ticket; devuelve el claim y las fuentes para que el bot corrija", async () => {
    generateTextMock.mockResolvedValue(verdict(false, "la mensualidad cubre llamadas"));
    const r = await guardReply(env, {
      replyText: "La mensualidad cubre llamadas y mensajes.",
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      businessContext: "",
      reintentable: true,
      conversationId: convId,
    });
    expect(r.action).toBe("rejected");
    expect(r.unsupportedClaim).toBe("la mensualidad cubre llamadas");
    expect(r.fuentes?.length).toBe(KB_PASSAGES.length);
    expect(r.finalText).toBe("La mensualidad cubre llamadas y mensajes.");
    expect(await new TicketsRepo(db).listOpen()).toHaveLength(0);
    expect(fetchMock.mock.calls.find(([u]) => String(u).includes("api.telegram.org"))).toBeUndefined();
  });

  it("reintentable: si la respuesta sí tiene respaldo, sale igual que siempre", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    const r = await guardReply(env, {
      replyText: "El corte cuesta $150.",
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      businessContext: "",
      reintentable: true,
      conversationId: convId,
    });
    expect(r.action).toBe("sent-original");
  });

  it("sin siempre, una respuesta sin cifras ni KB sigue sin verificarse", async () => {
    const r = await guardReply(env, {
      replyText: "Claro, cuéntame un poco más de tu clínica.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      conversationId: convId,
    });
    expect(r.action).toBe("skipped-no-claims");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("consultasKb: en relevo se trae el documento de opciones aunque la consulta por la respuesta no lo encuentre", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ matches: [] }) // consulta con la respuesta: nada
      .mockResolvedValueOnce({
        matches: [{ score: 0.41, metadata: { title: "Opciones para arrancar", content: "Pago en 3 pagos iguales; el dueño arma el plan." } }],
      });
    const envConKb = { ...env, AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) }, KB: { query } } as unknown as Env;

    await guardReply(envConKb, {
      replyText: "Victor puede dividir el pago en 3 o 6 cuotas.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      consultasKb: ["Opciones para arrancar con menos inversión"],
      conversationId: convId,
    });

    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("el dueño arma el plan");
  });

  it("el ticket dice cuántos pasajes de la KB vio el verificador y la mejor coincidencia", async () => {
    generateTextMock.mockResolvedValue(verdict(false, "el corte cuesta $80"));
    const envConKb = {
      ...env,
      AI: { run: vi.fn(async () => ({ data: [[0.1]] })) },
      KB: { query: vi.fn(async () => ({ matches: [{ score: 0.62, metadata: { title: "Precios", content: "Corte: $150" } }] })) },
    } as unknown as Env;
    await guardReply(envConKb, {
      replyText: "El corte te sale en $80.",
      turnUsedKb: false,
      kbPassages: [],
      businessContext: "",
      conversationId: convId,
    });
    const [t] = await new TicketsRepo(db).listOpen();
    expect(t.summary).toMatch(/KB consultada: 1 pasaje/);
    expect(t.summary).toMatch(/mejor 0\.62/);
  });

  it("si la consulta de la KB falla, el verificador sigue con lo que tenga (fail-open)", async () => {
    generateTextMock.mockResolvedValue(verdict(true));
    const envRota = { ...env, AI: { run: vi.fn(async () => { throw new Error("ai caído"); }) }, KB: { query: vi.fn() } } as unknown as Env;
    const r = await guardReply(envRota, {
      replyText: "El corte cuesta $150.",
      turnUsedKb: false,
      kbPassages: KB_PASSAGES,
      businessContext: "",
      conversationId: convId,
    });
    expect(r.action).toBe("sent-original");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("esRespuestaSegura reconoce los textos de reemplazo, en cualquier idioma y modo", () => {
    for (const lang of ["es", "es-ES", "en", "pt"]) {
      expect(esRespuestaSegura(safeConfirmReply(lang))).toBe(true);
      expect(esRespuestaSegura(safeConfirmReply(lang, { relevo: true }))).toBe(true);
    }
    expect(esRespuestaSegura("  " + safeConfirmReply("es") + " ")).toBe(true);
    expect(esRespuestaSegura("Claro, te explico cómo funciona.")).toBe(false);
    expect(esRespuestaSegura("")).toBe(false);
  });

  it("safeConfirmReply en relevo respeta el idioma", () => {
    expect(safeConfirmReply("en", { relevo: true })).toMatch(/who helped you/i);
    expect(safeConfirmReply("pt", { relevo: true })).toMatch(/atendeu/i);
    expect(safeConfirmReply("es", { relevo: false })).toBe(safeConfirmReply("es"));
  });

  it("unsupported → respuesta segura + ticket con el claim + aviso al dueño", async () => {
    generateTextMock.mockResolvedValue(verdict(false, "el corte cuesta $80"));

    const r = await guardReply(env, {
      replyText: "¡Claro! El corte te sale en $80.",
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      businessContext: "Corte: $150",
      conversationId: convId,
    });

    expect(r.action).toBe("replaced");
    expect(r.finalText).toBe(safeConfirmReply("es"));
    expect(r.finalText).toContain("confirma");
    expect(r.unsupportedClaim).toBe("el corte cuesta $80");

    const tickets = await new TicketsRepo(db).listOpen();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].summary).toContain("dato sin respaldo");
    expect(tickets[0].summary).toContain("el corte cuesta $80");
    const conv = await db.first<{ open_ticket_id: string | null }>(
      "SELECT open_ticket_id FROM conversations WHERE id = ?",
      [convId],
    );
    expect(conv?.open_ticket_id).toBe(tickets[0].id);

    const tgCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.telegram.org"));
    expect(tgCall).toBeTruthy();
    expect(String(tgCall![1]?.body)).toContain("dato sin respaldo");

    expect(await settings.get(SETTING_KEYS.blindajeChecks)).toBe("1");
    expect(await settings.get(SETTING_KEYS.blindajeBlocked)).toBe("1");
  });

  it("FAIL-OPEN: el verificador truena → sale la original intacta, sin ticket", async () => {
    generateTextMock.mockRejectedValue(new Error("anthropic 500"));
    const original = "El corte cuesta $150.";

    const r = await guardReply(env, {
      replyText: original,
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      conversationId: convId,
    });

    expect(r.action).toBe("fail-open");
    expect(r.finalText).toBe(original);
    expect(await new TicketsRepo(db).listOpen()).toHaveLength(0);
  });

  it("FAIL-OPEN: timeout del verificador → sale la original intacta", async () => {
    generateTextMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(verdict(true)), 200)),
    );
    const original = "Cuesta $220 el combo.";

    const r = await guardReply(env, {
      replyText: original,
      turnUsedKb: false,
      kbPassages: [],
      conversationId: convId,
      timeoutMs: 25,
    });

    expect(r.action).toBe("fail-open");
    expect(r.finalText).toBe(original);
  });

  it("FAIL-OPEN: veredicto que no es JSON → sale la original intacta", async () => {
    generateTextMock.mockResolvedValue({ text: "mmm no estoy seguro" });
    const original = "Son $300 con envío.";

    const r = await guardReply(env, {
      replyText: original,
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      conversationId: convId,
    });

    expect(r.action).toBe("fail-open");
    expect(r.finalText).toBe(original);
  });

  it("tier FREE → no verifica nada (ni una llamada al modelo)", async () => {
    const freeEnv = { ...env, BOT_TIER: "free" } as Env;
    const original = "El corte cuesta $9999 y es gratis los lunes.";

    const r = await guardReply(freeEnv, {
      replyText: original,
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      conversationId: convId,
    });

    expect(r.action).toBe("skipped-free");
    expect(r.finalText).toBe(original);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("interruptor blindaje_enabled=off → no verifica nada", async () => {
    await settings.set(SETTING_KEYS.blindajeEnabled, "off");
    const original = "El corte cuesta $9999.";

    const r = await guardReply(env, {
      replyText: original,
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      conversationId: convId,
    });

    expect(r.action).toBe("skipped-off");
    expect(r.finalText).toBe(original);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("respuesta sin datos y sin KB este turno → no llama al verificador", async () => {
    const original = "¡Hola! Claro que sí, con gusto te ayudo.";

    const r = await guardReply(env, {
      replyText: original,
      turnUsedKb: false,
      kbPassages: [],
      conversationId: convId,
    });

    expect(r.action).toBe("skipped-no-claims");
    expect(r.finalText).toBe(original);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("respeta BOT_LANGUAGE en la respuesta segura", async () => {
    generateTextMock.mockResolvedValue(verdict(false, "the haircut is $80"));
    const enEnv = { ...env, BOT_LANGUAGE: "en" } as Env;

    const r = await guardReply(enEnv, {
      replyText: "Sure! The haircut is $80.",
      turnUsedKb: true,
      kbPassages: KB_PASSAGES,
      conversationId: convId,
    });

    expect(r.action).toBe("replaced");
    expect(r.finalText).toBe(safeConfirmReply("en"));
    expect(r.finalText).toContain("double-check");
  });
});
