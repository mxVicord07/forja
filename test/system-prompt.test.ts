import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentDateLine,
  renderSystemPrompt,
  systemPromptFromEnv,
  type SystemPromptInput,
} from "../src/system-prompt";

const input: SystemPromptInput = {
  botName: "Asistente",
  businessName: "Barbería Centro",
  language: "es",
  businessContext: "Horarios: Lun-Sáb 10am-8pm\nUbicación: Monterrey",
  toolList: ["searchKb", "handoffHuman", "pauseBot"],
};

describe("renderSystemPrompt", () => {
  it("contains all 10 sections", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("<output_language>");
    expect(prompt).toContain("<role>");
    expect(prompt).toContain("<business_context>");
    expect(prompt).toContain("<identity_and_voice>");
    expect(prompt).toContain("<core_principles>");
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("<escalation_rules>");
    expect(prompt).toContain("<style_guide>");
    expect(prompt).toContain("<anti_patterns>");
  });

  it("replaces every placeholder (none left)", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("}}");
  });

  it("interpolates language, bot name and business name", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("es");
    expect(prompt).toContain("Asistente");
    expect(prompt).toContain("Barbería Centro");
  });

  it("renders tool list as bullet lines", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("- handoffHuman");
    expect(prompt).toContain("- pauseBot");
  });

  it("injects business context", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("Horarios: Lun-Sáb 10am-8pm");
  });

  it("renders customInstructions as an additive block and omits it when absent", () => {
    const withInstructions = renderSystemPrompt({
      ...input,
      customInstructions: "Siempre ofrece agendar una cita al final.",
    });
    expect(withInstructions).toContain("<instrucciones_del_negocio>");
    expect(withInstructions).toContain("Siempre ofrece agendar una cita al final.");

    const without = renderSystemPrompt(input);
    expect(without).not.toContain("<instrucciones_del_negocio>");
    expect(without).not.toContain("{{INSTRUCCIONES}}");

    // Espacios en blanco cuentan como "sin instrucciones":
    const blank = renderSystemPrompt({ ...input, customInstructions: "   " });
    expect(blank).not.toContain("<instrucciones_del_negocio>");
  });

  it("inserts nichoPlaybook when provided and empty string when omitted", () => {
    const withPlaybook = renderSystemPrompt({
      ...input,
      nichoPlaybook: "<diagnostic_playbooks>X</diagnostic_playbooks>",
    });
    expect(withPlaybook).toContain("<diagnostic_playbooks>X</diagnostic_playbooks>");
    // omitted -> the placeholder is gone, replaced by ""
    const withoutPlaybook = renderSystemPrompt(input);
    expect(withoutPlaybook).not.toContain("{{NICHO_PLAYBOOK}}");
  });

  it("keeps the fixed single-language instructions by default", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("THE COACH'S CUSTOMER PREFERS LANGUAGE");
    expect(prompt).not.toContain("MIRRORS THE CUSTOMER'S LANGUAGE");
  });

  it("translates the raw language code to a natural, dialect-aware description (idioma.ts)", () => {
    // "es" solo ya no debe llegar crudo al prompt — descripcionIdioma() lo
    // traduce a una instrucción accionable, no un código que el modelo tenga
    // que adivinar.
    const prompt = renderSystemPrompt({ ...input, language: "es" });
    expect(prompt).not.toContain("PREFERS LANGUAGE: es\n");
    expect(prompt).toContain("español latinoamericano");

    // El caso real que motivó el porteo: distinguir los dos españoles.
    const es = renderSystemPrompt({ ...input, language: "es-ES" });
    expect(es).toContain("vosotros");
    expect(es).toContain("NO uses mexicanismos");

    // Un código que no reconoce pasa TAL CUAL (no inventa nada) — mismo
    // comportamiento que antes de este porteo para lo desconocido.
    const catalan = renderSystemPrompt({ ...input, language: "catalán" });
    expect(catalan).toContain("PREFERS LANGUAGE: catalán");
  });

  it('switches to mirror-language instructions when language is "espejo"', () => {
    const prompt = renderSystemPrompt({ ...input, language: "espejo" });
    expect(prompt).toContain("THE BOT MIRRORS THE CUSTOMER'S LANGUAGE");
    expect(prompt).not.toContain("THE COACH'S CUSTOMER PREFERS LANGUAGE");
  });

  it("injects formattingRules inside <style_guide>, not identity_and_voice", () => {
    const prompt = renderSystemPrompt({ ...input, formattingRules: "usa 2-4 emojis clave" });
    const styleGuide = prompt.slice(prompt.indexOf("<style_guide>"), prompt.indexOf("</style_guide>"));
    expect(styleGuide).toContain("usa 2-4 emojis clave");
    const identity = prompt.slice(prompt.indexOf("<identity_and_voice>"), prompt.indexOf("</identity_and_voice>"));
    expect(identity).not.toContain("usa 2-4 emojis clave");
  });

  it("omits {{EXTRA_STYLE}} placeholder when formattingRules is absent", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).not.toContain("{{EXTRA_STYLE}}");
  });

  it("injects a <brand_voice> block after <identity_and_voice> when brandVoice is set", () => {
    const prompt = renderSystemPrompt({
      ...input,
      brandVoice: "Tuteamos, cerramos con 'aquí ando pa lo que ocupes', 1 emoji máx.",
    });
    expect(prompt).toContain("<brand_voice>");
    const block = prompt.slice(prompt.indexOf("<brand_voice>"), prompt.indexOf("</brand_voice>"));
    expect(block).toContain("aquí ando pa lo que ocupes");
    // Debe recordar, dentro del propio bloque, que la voz no manda sobre los frenos.
    expect(block).toContain("output_language");
    expect(block).toContain("escalation_rules");
  });

  it("omits the <brand_voice> block entirely when brandVoice is absent", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).not.toContain("<brand_voice>");
    expect(prompt).not.toContain("{{BRAND_VOICE}}");
  });

  it("never lets brandVoice touch core_principles, escalation_rules or anti_patterns", () => {
    const prompt = renderSystemPrompt({
      ...input,
      brandVoice: "Prometo lo que sea con tal de cerrar la venta.",
    });
    const core = prompt.slice(prompt.indexOf("<core_principles>"), prompt.indexOf("</core_principles>"));
    const escalation = prompt.slice(prompt.indexOf("<escalation_rules>"), prompt.indexOf("</escalation_rules>"));
    const antiPatterns = prompt.slice(prompt.indexOf("<anti_patterns>"), prompt.indexOf("</anti_patterns>"));
    expect(core).not.toContain("Prometo lo que sea");
    expect(escalation).not.toContain("Prometo lo que sea");
    expect(antiPatterns).not.toContain("Prometo lo que sea");
  });
});

describe("currentDateLine", () => {
  afterEach(() => vi.useRealTimers());

  it("ancla jueves 2026-08-27 en Europe/Madrid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T15:00:00.000Z"));
    const line = currentDateLine("Europe/Madrid");
    expect(line).toContain("2026-08-27");
    expect(line.toLowerCase()).toContain("jueves");
    expect(line).toContain("Europe/Madrid");
  });
});

describe("systemPromptFromEnv", () => {
  it("asks the model to pass relative date words, not a self-computed YYYY-MM-DD", () => {
    const env = {
      BOT_NAME: "Bot",
      BUSINESS_NAME: "Acme",
      BOT_LANGUAGE: "es",
      CALCOM_TIMEZONE: "Europe/Madrid",
    } as any;
    const prompt = systemPromptFromEnv(env, ["scheduleAppointment"], "ctx");
    expect(prompt).toContain("<contexto_temporal>");
    expect(prompt).toContain("PALABRAS del cliente");
    expect(prompt).not.toContain("y para toda fecha que pases a las tools");
  });

  it("pulls botName/businessName/language from env", () => {
    const env = {
      BOT_NAME: "Bot",
      BUSINESS_NAME: "Acme",
      BOT_LANGUAGE: "en",
    } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb"], "ctx here");
    expect(prompt).toContain("Bot");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("en");
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("ctx here");
  });
});
