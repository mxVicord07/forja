import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../src/db/settings";
import { resolveAgentConfig, DEFAULT_MONTHLY_BUDGET_USD } from "../src/settings-loader";

const TOOLS = ["searchKb", "handoffHuman"];

let env: any;
let repo: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = {
    DB: d1,
    BOT_NAME: "Asistente",
    BUSINESS_NAME: "Test Business",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "12",
  };
  repo = new SettingsRepo(new Db(d1 as any));
});

describe("resolveAgentConfig", () => {
  it("uses env/defaults when settings are empty", async () => {
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.bufferMs).toBe(12_000); // from BUFFER_SECONDS
    expect(cfg.maxChunks).toBe(3);
    expect(cfg.interChunkDelayMs).toBe(1000);
    expect(cfg.modelOverride).toBe("auto");
    expect(cfg.botPaused).toBe(false);
    expect(cfg.systemPrompt).toContain("Asistente"); // env BOT_NAME
    expect(cfg.systemPrompt).toContain("<role>");
    expect(cfg.systemPrompt).not.toContain("{{");
  });

  it("system_prompt_override wins over the generated prompt", async () => {
    await repo.set(SETTING_KEYS.systemPromptOverride, "MI PROMPT CUSTOM");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toBe("MI PROMPT CUSTOM");
  });

  it("applies bot_name, tone and escalation_keywords into the generated prompt", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    await repo.set(SETTING_KEYS.tone, "divertido y relajado");
    await repo.set(SETTING_KEYS.escalationKeywords, "reembolso, gerente");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("Pelusa");
    expect(cfg.systemPrompt).toContain("divertido y relajado");
    expect(cfg.systemPrompt).toContain("reembolso, gerente");
  });

  it("uses business_context override when present", async () => {
    await repo.set(SETTING_KEYS.businessContext, "MI CONTEXTO DE NEGOCIO");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("MI CONTEXTO DE NEGOCIO");
  });

  // --- Campos de Forja Inbox: SE SUMAN al business_context, no lo reemplazan ---

  it("faqs editadas desde la app llegan al prompt, sumadas al override", async () => {
    await repo.set(SETTING_KEYS.businessContext, "MI CONTEXTO DE NEGOCIO");
    await repo.set(
      SETTING_KEYS.faqs,
      JSON.stringify([{ id: "1", question: "¿Hacen envíos?", answer: "Sí, a todo el país" }]),
    );
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("MI CONTEXTO DE NEGOCIO");
    expect(cfg.systemPrompt).toContain("¿Hacen envíos?");
    expect(cfg.systemPrompt).toContain("Sí, a todo el país");
  });

  it("promo vencida NO se inyecta al prompt", async () => {
    await repo.set(
      SETTING_KEYS.promo,
      JSON.stringify({ active: true, text: "2x1 en todo", endsAt: "2020-01-01" }),
    );
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("2x1 en todo");
  });

  it("promo vigente SÍ se inyecta", async () => {
    await repo.set(SETTING_KEYS.promo, JSON.stringify({ active: true, text: "2x1 en todo" }));
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("2x1 en todo");
  });

  it("horario estructurado corrupto no tumba la resolución del prompt", async () => {
    await repo.set(SETTING_KEYS.businessHours, "{esto no es JSON válido");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toBeTruthy();
  });

  it("un bot sin ningún campo de Forja Inbox tocado queda con el business_context de siempre, sin bloques vacíos colgando", async () => {
    const sinExtras = await resolveAgentConfig(env, TOOLS);
    await repo.set(SETTING_KEYS.faqs, JSON.stringify([{ question: "¿?", answer: "!" }]));
    const conExtra = await resolveAgentConfig(env, TOOLS);
    const extraer = (p: string) => /<business_context>([\s\S]*?)<\/business_context>/.exec(p)?.[1] ?? "";
    // Ningún campo tocado → el bloque queda EXACTO al de siempre (join con un
    // solo elemento no agrega separador de más).
    expect(extraer(sinExtras.systemPrompt)).not.toMatch(/\n\n\n/);
    // Con un solo campo extra tocado, exactamente UN separador entre bloques.
    expect(extraer(conExtra.systemPrompt)).not.toMatch(/\n\n\n/);
  });

  it("buffer_seconds overrides env and enforces a 1000ms floor", async () => {
    await repo.set(SETTING_KEYS.bufferSeconds, "5");
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.bufferMs).toBe(5000);

    await repo.set(SETTING_KEYS.bufferSeconds, "0");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.bufferMs).toBe(1000);
  });

  it("clamps max_chunks to 1..5", async () => {
    await repo.set(SETTING_KEYS.maxChunks, "99");
    expect((await resolveAgentConfig(env, TOOLS)).maxChunks).toBe(5);
    await repo.set(SETTING_KEYS.maxChunks, "0");
    expect((await resolveAgentConfig(env, TOOLS)).maxChunks).toBe(1);
    await repo.set(SETTING_KEYS.maxChunks, "2");
    expect((await resolveAgentConfig(env, TOOLS)).maxChunks).toBe(2);
  });

  it("clamps inter_chunk_delay_ms to 0..5000", async () => {
    await repo.set(SETTING_KEYS.interChunkDelayMs, "999999");
    expect((await resolveAgentConfig(env, TOOLS)).interChunkDelayMs).toBe(5000);
    await repo.set(SETTING_KEYS.interChunkDelayMs, "-50");
    expect((await resolveAgentConfig(env, TOOLS)).interChunkDelayMs).toBe(0);
  });

  it("parses model_override and falls back to auto for garbage", async () => {
    await repo.set(SETTING_KEYS.modelOverride, "haiku");
    expect((await resolveAgentConfig(env, TOOLS)).modelOverride).toBe("haiku");
    await repo.set(SETTING_KEYS.modelOverride, "sonnet");
    expect((await resolveAgentConfig(env, TOOLS)).modelOverride).toBe("sonnet");
    await repo.set(SETTING_KEYS.modelOverride, "nonsense");
    expect((await resolveAgentConfig(env, TOOLS)).modelOverride).toBe("auto");
  });

  it("reads bot_paused as a boolean (1 => true, anything else => false)", async () => {
    await repo.set(SETTING_KEYS.botPaused, "1");
    expect((await resolveAgentConfig(env, TOOLS)).botPaused).toBe(true);
    await repo.set(SETTING_KEYS.botPaused, "0");
    expect((await resolveAgentConfig(env, TOOLS)).botPaused).toBe(false);
  });

  it("bot_paused_until (Forja Inbox, POST /api/pause) pausa aunque bot_paused esté en 0", async () => {
    await repo.set(SETTING_KEYS.botPaused, "0");
    await repo.set(SETTING_KEYS.botPausedUntil, String(Date.now() + 60_000));
    expect((await resolveAgentConfig(env, TOOLS)).botPaused).toBe(true);
  });

  it("una pausa temporal ya vencida ya no pausa el bot", async () => {
    await repo.set(SETTING_KEYS.botPaused, "0");
    await repo.set(SETTING_KEYS.botPausedUntil, String(Date.now() - 1000));
    expect((await resolveAgentConfig(env, TOOLS)).botPaused).toBe(false);
  });

  it('typing_indicator viene encendido por default y solo un "0" explícito lo apaga', async () => {
    expect((await resolveAgentConfig(env, TOOLS)).typingIndicator).toBe(true);
    await repo.set(SETTING_KEYS.typingIndicator, "0");
    expect((await resolveAgentConfig(env, TOOLS)).typingIndicator).toBe(false);
    await repo.set(SETTING_KEYS.typingIndicator, "1");
    expect((await resolveAgentConfig(env, TOOLS)).typingIndicator).toBe(true);
  });
});

describe("resolveAgentConfig — disabled_tools", () => {
  it("filters enabledToolNames and the prompt's tool list", async () => {
    await repo.set(SETTING_KEYS.disabledTools, "handoffHuman");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(["searchKb"]);
    expect(cfg.systemPrompt).toContain("- searchKb");
    expect(cfg.systemPrompt).not.toContain("- handoffHuman");
  });

  it("keeps everything enabled when the setting is absent or empty", async () => {
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(TOOLS);

    await repo.set(SETTING_KEYS.disabledTools, "  ");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(TOOLS);
  });

  it("ignores unknown names in the setting", async () => {
    await repo.set(SETTING_KEYS.disabledTools, "noExiste, searchKb");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(["handoffHuman"]);
  });

  // sendPaymentLink (skill /cobros): opt-in REAL vía payments_enabled, no vía
  // disabled_tools — aunque buildTools() ya la haya registrado (isPro +
  // stripeConfigured), no debe ofrecerse al modelo hasta que el dueño
  // confirme. Distinto de todo lo demás: el resto empieza ENCENDIDO salvo que
  // se apague; esta empieza APAGADA salvo que se prenda.
  it("sendPaymentLink queda fuera de enabledToolNames aunque esté en la lista, hasta que payments_enabled='1'", async () => {
    const toolsConCobros = [...TOOLS, "sendPaymentLink"];
    let cfg = await resolveAgentConfig(env, toolsConCobros);
    expect(cfg.enabledToolNames).toEqual(TOOLS); // sin sendPaymentLink

    await repo.set(SETTING_KEYS.paymentsEnabled, "1");
    cfg = await resolveAgentConfig(env, toolsConCobros);
    expect(cfg.enabledToolNames).toEqual(toolsConCobros); // ahora sí aparece

    await repo.set(SETTING_KEYS.paymentsEnabled, "0");
    cfg = await resolveAgentConfig(env, toolsConCobros);
    expect(cfg.enabledToolNames).toEqual(TOOLS); // "0" explícito también la apaga
  });
});

describe("resolveAgentConfig — temperature", () => {
  it("is undefined when unset (provider default)", async () => {
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.temperature).toBeUndefined();
  });

  it("parses and clamps the stored value to [0, 1]", async () => {
    await repo.set(SETTING_KEYS.temperature, "0.3");
    expect((await resolveAgentConfig(env, TOOLS)).temperature).toBe(0.3);

    await repo.set(SETTING_KEYS.temperature, "7");
    expect((await resolveAgentConfig(env, TOOLS)).temperature).toBe(1);
  });

  it("ignores garbage values", async () => {
    await repo.set(SETTING_KEYS.temperature, "caliente");
    expect((await resolveAgentConfig(env, TOOLS)).temperature).toBeUndefined();
  });
});

describe("resolveAgentConfig — custom_instructions", () => {
  it("suma las instrucciones al prompt generado sin congelarlo", async () => {
    await repo.set(SETTING_KEYS.customInstructions, "Siempre ofrece agendar una cita al final.");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("<instrucciones_del_negocio>");
    expect(cfg.systemPrompt).toContain("Siempre ofrece agendar una cita al final.");
    // El resto del cerebro sigue ahí — sumar, no reemplazar:
    expect(cfg.systemPrompt).toContain("<role>");
    expect(cfg.systemPrompt).toContain("<business_context>");
    expect(cfg.systemPrompt).toContain("<anti_patterns>");
  });

  it("omite el bloque cuando no hay instrucciones (o son espacios)", async () => {
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<instrucciones_del_negocio>");

    await repo.set(SETTING_KEYS.customInstructions, "   ");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<instrucciones_del_negocio>");
  });

  it("con un prompt manual activo NO aplican (el override es 'tal cual')", async () => {
    await repo.set(SETTING_KEYS.customInstructions, "Siempre ofrece agendar una cita.");
    await repo.set(SETTING_KEYS.systemPromptOverride, "MI PROMPT CUSTOM");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toBe("MI PROMPT CUSTOM");
  });
});

describe("resolveAgentConfig — buttons_enabled (skill /botones)", () => {
  it("apagado por default: el prompt no enseña el marcador", async () => {
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<botones>");
  });

  it('buttons_enabled="1" enseña el marcador [[botones: …]]', async () => {
    await repo.set(SETTING_KEYS.buttonsEnabled, "1");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("<botones>");
    expect(cfg.systemPrompt).toContain("[[botones:");
  });

  it('cualquier valor que no sea "1" cuenta como apagado', async () => {
    await repo.set(SETTING_KEYS.buttonsEnabled, "0");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<botones>");
  });
});

describe("resolveAgentConfig — learned lessons (flywheel)", () => {
  it("injects lessons into the generated prompt", async () => {
    await repo.set(SETTING_KEYS.learnedLessons, JSON.stringify(["Confirma el pago antes de prometer acceso."]));
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("<lecciones_aprendidas>");
    expect(cfg.systemPrompt).toContain("Confirma el pago antes de prometer acceso.");
  });

  it("omits the block without lessons and tolerates malformed JSON", async () => {
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<lecciones_aprendidas>");

    await repo.set(SETTING_KEYS.learnedLessons, "{no es json");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<lecciones_aprendidas>");
  });

  it("injects brand_voice into the prompt on Pro", async () => {
    await repo.set(SETTING_KEYS.brandVoice, "Tuteamos, cerramos con 'aquí ando pa lo que ocupes'.");
    const cfg = await resolveAgentConfig(env, TOOLS); // env.BOT_TIER = "pro"
    expect(cfg.systemPrompt).toContain("<brand_voice>");
    expect(cfg.systemPrompt).toContain("aquí ando pa lo que ocupes");
  });

  it("ignores brand_voice on free tier, aunque el setting exista", async () => {
    await repo.set(SETTING_KEYS.brandVoice, "Tuteamos, cerramos con 'aquí ando pa lo que ocupes'.");
    const cfg = await resolveAgentConfig({ ...env, BOT_TIER: "free" }, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<brand_voice>");
    expect(cfg.systemPrompt).not.toContain("aquí ando pa lo que ocupes");
  });
});

describe("resolveAgentConfig — monthly_budget default (Forja Inbox, adoptado del paquete v1.0.76)", () => {
  it("sin setting, cae al tope sugerido de verdad (antes quedaba sin tope)", async () => {
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.monthlyBudgetUsd).toBe(DEFAULT_MONTHLY_BUDGET_USD);
  });

  it('"0" explícito sigue significando SIN tope — el default solo aplica a la ausencia', async () => {
    await repo.set(SETTING_KEYS.monthlyBudget, "0");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.monthlyBudgetUsd).toBeUndefined();
  });

  it("un tope explícito del dueño gana sobre el default", async () => {
    await repo.set(SETTING_KEYS.monthlyBudget, "10");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.monthlyBudgetUsd).toBe(10);
  });
});

describe("resolveAgentConfig — INTERNAL_CHANNEL (equipo interno, no clientes)", () => {
  it("sin INTERNAL_CHANNEL, cualquier canal usa el prompt normal con sus tools", async () => {
    const cfg = await resolveAgentConfig(env, TOOLS, "telegram");
    expect(cfg.systemPrompt).toContain("<role>");
    expect(cfg.enabledToolNames).toEqual(TOOLS);
  });

  it("con INTERNAL_CHANNEL, el canal marcado usa el prompt interno y no trae tools", async () => {
    const cfg = await resolveAgentConfig({ ...env, INTERNAL_CHANNEL: "telegram" }, TOOLS, "telegram");
    expect(cfg.systemPrompt).toContain("asistente interno");
    expect(cfg.systemPrompt).not.toContain("<role>");
    expect(cfg.enabledToolNames).toEqual([]);
  });

  it("con INTERNAL_CHANNEL configurado, otro canal (whatsapp) sigue con el prompt normal", async () => {
    const cfg = await resolveAgentConfig({ ...env, INTERNAL_CHANNEL: "telegram" }, TOOLS, "whatsapp");
    expect(cfg.systemPrompt).toContain("<role>");
    expect(cfg.enabledToolNames).toEqual(TOOLS);
  });

  it("el prompt interno gana incluso sobre un system_prompt_override manual (son prompts para audiencias distintas)", async () => {
    await repo.set(SETTING_KEYS.systemPromptOverride, "MI PROMPT CUSTOM PARA CLIENTES");
    const cfg = await resolveAgentConfig({ ...env, INTERNAL_CHANNEL: "telegram" }, TOOLS, "telegram");
    expect(cfg.systemPrompt).toContain("asistente interno");
    expect(cfg.systemPrompt).not.toBe("MI PROMPT CUSTOM PARA CLIENTES");
  });
});
