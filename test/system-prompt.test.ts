import { describe, it, expect } from "vitest";
import {
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
    expect(prompt).toContain("THE COACH'S CUSTOMER PREFERS LANGUAGE: es");
    expect(prompt).not.toContain("MIRRORS THE CUSTOMER'S LANGUAGE");
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
});

describe("systemPromptFromEnv", () => {
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
