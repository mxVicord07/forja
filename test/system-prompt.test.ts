import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentDateLine,
  renderInternalSystemPrompt,
  renderSystemPrompt,
  systemPromptFromEnv,
  upcomingCalendar,
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

  it("prohíbe prometer recordatorios o mensajes para otra fecha que el bot no puede programar (caso Jocelyn, 9-nov-2026)", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("Prometer un recordatorio, una llamada o un mensaje para otra fecha");
    expect(prompt).toContain("se lo pasas al dueño");
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

  it("renders the botones block only when buttonsEnabled, byte-identical prompt when off", () => {
    const on = renderSystemPrompt({ ...input, buttonsEnabled: true });
    expect(on).toContain("<botones>");
    expect(on).toContain("[[botones: Opción uno | Opción dos | Opción tres]]");

    const off = renderSystemPrompt(input);
    expect(off).not.toContain("<botones>");
    expect(off).not.toContain("{{BOTONES}}");

    // apagado explícito (false) da el MISMO prompt que omitirlo del todo.
    const explicitOff = renderSystemPrompt({ ...input, buttonsEnabled: false });
    expect(explicitOff).toBe(off);
  });

  // Hallazgo 19-sep-2026: la sola regla abstracta en <botones> no bastaba —
  // Haiku 4.5 nunca emitió el marcador en pruebas reales de WhatsApp, ni en
  // cierres de libro de texto. El fix agrega un recordatorio concreto DENTRO
  // de <core_principles> (más arriba, más peso) además del ejemplo resuelto
  // en <botones>. Este test fija que ambos refuerzos sigan presentes.
  it("reinforces botones with a concrete reminder inside core_principles and a worked example", () => {
    const on = renderSystemPrompt({ ...input, buttonsEnabled: true });
    const corePrinciples = on.slice(on.indexOf("<core_principles>"), on.indexOf("</core_principles>"));
    expect(corePrinciples).toContain("[[botones: Lunes | Otro día]]");

    // El ejemplo resuelto dentro de <botones> (no solo la especificación del formato).
    const botones = on.slice(on.indexOf("<botones>"), on.indexOf("</botones>"));
    expect(botones).toContain("Ejemplo completo");
    expect(botones).toContain("Cliente:");

    // Apagado: ninguno de los dos refuerzos aparece, y sigue byte-idéntico al off de siempre.
    const off = renderSystemPrompt(input);
    expect(off).not.toContain("{{CORE_PRINCIPLES_BOTONES}}");
    expect(off).not.toContain("[[botones: Lunes | Otro día]]");
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

describe("upcomingCalendar", () => {
  afterEach(() => vi.useRealTimers());

  it("el 4-nov-2026 (miércoles) la próxima semana empieza el lunes 9 y el viernes es 13, no 10 y 15", () => {
    const cal = upcomingCalendar("America/Mexico_City", 21, new Date("2026-11-04T15:10:00.000Z"));
    const lineas = cal.split("\n");
    expect(lineas).toHaveLength(21);
    expect(lineas[0]).toBe("- hoy miércoles, 4 de noviembre");
    expect(lineas[1]).toBe("- mañana jueves, 5 de noviembre");
    expect(cal).toContain("- lunes, 9 de noviembre (aquí empieza una semana nueva)");
    expect(cal).toContain("- viernes, 13 de noviembre");
    expect(cal).not.toContain("lunes, 10 de noviembre");
  });

  it("usa la fecha de la zona del negocio: a las 2am UTC del 5 sigue siendo 4 en México", () => {
    const cal = upcomingCalendar("America/Mexico_City", 2, new Date("2026-11-05T02:00:00.000Z"));
    expect(cal.split("\n")[0]).toBe("- hoy miércoles, 4 de noviembre");
  });

  it("un cambio de horario no repite ni salta días", () => {
    const cal = upcomingCalendar("Europe/Madrid", 10, new Date("2026-10-22T10:00:00.000Z"));
    expect(cal.split("\n").map((l) => l.replace(/^- (hoy |mañana )?/, ""))).toEqual([
      "jueves, 22 de octubre", "viernes, 23 de octubre", "sábado, 24 de octubre", "domingo, 25 de octubre",
      "lunes, 26 de octubre (aquí empieza una semana nueva)", "martes, 27 de octubre", "miércoles, 28 de octubre",
      "jueves, 29 de octubre", "viernes, 30 de octubre", "sábado, 31 de octubre",
    ]);
  });

  it("el prompt incluye el calendario y la regla de leerlo en vez de calcularlo", () => {
    const env = { BOT_NAME: "Bot", BUSINESS_NAME: "Acme", BOT_LANGUAGE: "es", CALCOM_TIMEZONE: "America/Mexico_City" } as any;
    const prompt = systemPromptFromEnv(env, ["scheduleAppointment"], "ctx");
    expect(prompt).toContain("Calendario real de los próximos días");
    expect(prompt).toContain("nunca cuentes ni calcules el día de la semana");
    expect(prompt).toContain("aquí empieza una semana nueva");
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

  it("passes overrides.buttonsEnabled through to the botones block", () => {
    const env = { BOT_NAME: "Bot", BUSINESS_NAME: "Acme", BOT_LANGUAGE: "es" } as any;
    const on = systemPromptFromEnv(env, ["searchKb"], "ctx", undefined, { buttonsEnabled: true });
    expect(on).toContain("<botones>");
    const off = systemPromptFromEnv(env, ["searchKb"], "ctx");
    expect(off).not.toContain("<botones>");
  });
});

describe("renderInternalSystemPrompt", () => {
  it("names the business and marks itself as the internal/team assistant", () => {
    const prompt = renderInternalSystemPrompt("BIRevX");
    expect(prompt).toContain("BIRevX");
    expect(prompt).toContain("interno");
  });

  it("does not reuse the customer-facing template sections", () => {
    const prompt = renderInternalSystemPrompt("BIRevX");
    expect(prompt).not.toContain("<escalation_rules>");
    expect(prompt).not.toContain("<anti_patterns>");
    expect(prompt).not.toContain("<tools>");
  });
});
