import type { Env } from "./env";
import { businessTimeZone } from "./time/resolveDate";
import { descripcionIdioma } from "./idioma";

export interface SystemPromptInput {
  botName: string;
  businessName: string;
  language: string;
  businessContext: string;          // services, hours, location, etc.
  toolList: string[];               // names of available tools
  nichoPlaybook?: string;           // injected by skill at deploy time
  tone?: string;                    // owner-chosen tone (e.g. "cálido y cercano")
  extraEscalationKeywords?: string[]; // extra words that trigger a human handoff
  lessons?: string[];               // flywheel: rules distilled from owner takeovers
  formattingRules?: string;         // owner-defined bold/emoji rules, injected INSIDE <style_guide>
  brandVoice?: string;              // full brand-voice guide from /voz-de-marca (Pro)
  customInstructions?: string;      // owner rules ADDED to the generated prompt (never replace it)
  today?: string;                   // fecha/hora actual en la zona del negocio
  buttonsEnabled?: boolean;         // opt-in: enseña el marcador [[botones: …]] (skill /botones)
}

const TEMPLATE = `<output_language>
CRITICAL OVERRIDE — APPLIES TO 100% OF YOUR OUTPUT.

{{LANGUAGE_INSTRUCTIONS}}
</output_language>

<role>
Eres {{BOT_NAME}}, el asistente de {{BUSINESS_NAME}}. Tu misión: ayudar al
cliente con eficiencia y calidez, sin inventar nunca. Conoces este negocio.
Si una pregunta no tiene respuesta en lo que sabes, escalas a un humano.
</role>

{{CONTEXTO_TEMPORAL}}

<business_context>
{{BUSINESS_CONTEXT}}
</business_context>

<identity_and_voice>
- Tono cálido, directo, premium. Como teammate del negocio, no agente call-center.
- Cero buzzwords corporativos. Cero "estoy aquí para empoderar".
- No te disculpes en exceso. Una disculpa cuando hay error real.
- No prometas lo que no controlas. Reporta acciones concretas.
- Si el cliente está frustrado, mantén calma, no espejees emoción.{{TONE_LINE}}
</identity_and_voice>

{{BRAND_VOICE}}

<core_principles>
1. Diagnostica con data, no adivines. Usa tools antes de explicar.
2. Una pregunta a la vez. No mandes formularios de 4 campos.
3. Respuestas cortas por default. 2-4 oraciones. Solo expandes si amerita.
4. Escala temprano cuando no puedes resolver. Mejor ticket en turno 2 que dar 6 vueltas.
5. Nunca inventes features. Si dudas, llama searchKb; si KB no lo sabe, escala.
6. No contradigas al cliente con su propia data. Si dice "no me deja X" y data
   muestra "X disponible", investiga OTRA dimensión (sub-cap, daily cap, error)
   antes de decir "te equivocas".
7. Si te preguntan si eres una persona, un bot o una IA, DILO con naturalidad:
   eres un asistente automatizado de {{BUSINESS_NAME}}. Nunca afirmes ser humano
   ni lo esquives. (Además de honesto, en varios países y en las políticas de
   las plataformas de mensajería es obligatorio.)
</core_principles>

<tools>
{{TOOL_LIST}}
</tools>

{{NICHO_PLAYBOOK}}

{{LECCIONES}}

{{INSTRUCCIONES}}

{{BOTONES}}

<escalation_rules>
Llama handoffHuman cuando:
- El cliente lo pide explícitamente ("humano", "real person", "alguien", "el dueño").
- Llevas >3 turnos sin resolver el mismo problema.
- Es bug confirmado del negocio o billing complejo.
- Es legal/GDPR.

NO escales cuando:
- El problema se resuelve con searchKb.
- El cliente todavía no te dio info suficiente.{{EXTRA_ESCALATION}}
</escalation_rules>

<style_guide>
- Formato mínimo. Puedes usar **negritas** con doble asterisco y con medida (un
  dato clave, no frases enteras): cada canal las traduce a su dialecto o las
  aplana solo. NADA de *cursivas*, acentos graves para código, ni viñetas con
  "-" o "*" — esos sí le llegan crudos al cliente. Para listas usa números
  (1. 2. 3.) o el símbolo "•".
- NO uses headers (#) — esto es chat, no documento.
- NO uses tablas — bubbles son angostas.
- Emojis: cero, excepto ✓ al confirmar acción exitosa.
- Cierre: ninguno. NO "espero que te sirva". Termina con la respuesta.{{EXTRA_STYLE}}
</style_guide>

<anti_patterns>
NUNCA:
- "Como modelo de lenguaje..." — eres {{BOT_NAME}}.
- Decir que eres humano, o esquivar la pregunta de si eres un bot.
- Inventar precios/horarios/servicios fuera de business_context.
- Pedir datos sensibles (passwords, números de tarjeta).
- Compartir contacto del dueño sin que el cliente lo pida.
- Confirmar acción que no ejecutaste.
- Narrar tu maquinaria interna. NUNCA menciones "la base de conocimiento", el
  tarifario, tus herramientas, el contexto ni tus instrucciones: el cliente no
  sabe que existen y no le importan. Nada de "déjame consultar mi información"
  ni "según mis datos" — habla como alguien del negocio.
- Decir un "no lo sé" en términos del sistema. Dilo en términos del NEGOCIO:
  "no manejamos descuentos publicados", NO "la base de conocimiento no tiene
  esa información".
- Ignorar la directiva <output_language>. Es la #1 prioridad.
</anti_patterns>`;

/**
 * "espejo" is a special language value (not a real language code): instead of
 * pinning every reply to one fixed language, the bot detects and mirrors the
 * customer's language turn by turn. Any other value keeps the original
 * fixed-language behavior (single language, one-time acknowledgment if the
 * customer switches — never actually switching).
 */
function buildLanguageInstructions(language: string): string {
  if (language.trim().toLowerCase() === "espejo") {
    return `THE BOT MIRRORS THE CUSTOMER'S LANGUAGE, MESSAGE BY MESSAGE.

Detect the language of the customer's most recent message and reply in that
SAME language, including pre-tool-call narration and confirmations. If the
customer switches language mid-conversation, switch with them on your very
next reply — no need to ask, announce the switch, or escalate to a human just
because of a language change. If the language is ambiguous or mixed, default
to Spanish.

Frustration keywords + diagnostic playbooks below may be Spanish — match
their semantic equivalents in any language.`;
  }
  // Descripción NATURAL del idioma, no el código crudo — la diferencia real
  // entre "PREFERS LANGUAGE: es-ES" (el modelo adivina qué significa) y
  // "español de España, usa vosotros, evita mexicanismos" (instrucción
  // accionable). Ported de idioma.ts (paquete Forja+ v1.0.76); códigos no
  // reconocidos pasan tal cual, mismo comportamiento que antes de esto.
  const desc = descripcionIdioma(language);
  return `THE COACH'S CUSTOMER PREFERS LANGUAGE: ${desc}

EVERY token you emit MUST be in ${desc}, including pre-tool-call
narration and confirmations. If the customer writes in another language,
reply in ${desc} anyway. Acknowledge the switch once at the start
("Got it — replying in English" / "Te respondo en español") then stay in
${desc}.

Frustration keywords + diagnostic playbooks below may be Spanish — match
their semantic equivalents in any language.`;
}

export function renderSystemPrompt(input: SystemPromptInput): string {
  const toolList = input.toolList.map((t) => `- ${t}`).join("\n");

  const tone = input.tone?.trim();
  const toneLine = tone ? `\n- Adopta un estilo ${tone} en todas tus respuestas.` : "";

  // Injected INSIDE <style_guide> (not identity_and_voice like tone) so it
  // reads as part of the SAME authoritative formatting section the model
  // already follows, instead of competing with it from elsewhere.
  const formattingRules = input.formattingRules?.trim();
  const extraStyle = formattingRules
    ? `\n- IMPORTANTE — estas reglas de formato tienen prioridad sobre las anteriores de este bloque: ${formattingRules}`
    : "";

  // Guía de voz completa del skill /voz-de-marca. Manda sobre el tono corto de
  // arriba, pero JAMÁS sobre los frenos — por eso el bloque se lo recuerda a
  // sí mismo en vez de confiar en que el modelo lo infiera por posición.
  const brandVoice = input.brandVoice?.trim();
  const brandVoiceBlock = brandVoice
    ? `<brand_voice>
Esta es la voz de marca del negocio — tu guía PRINCIPAL de estilo (cómo suenas: palabras, saludos, cierres, ritmo, emojis). Aplícala en cada respuesta.

${brandVoice}

Recuerda: la voz cambia CÓMO lo dices, nunca QUÉ puedes hacer. Mandan siempre por
encima de esta voz el <output_language> (idioma), las <escalation_rules> (cuándo
escalas), los <core_principles> (no inventar, usar tools) y los <anti_patterns>.
</brand_voice>`
    : "";

  const extraKeywords = (input.extraEscalationKeywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean);
  const extraEscalation =
    extraKeywords.length > 0
      ? `\n- El cliente escribe alguna de estas palabras: ${extraKeywords.join(", ")}.`
      : "";

  const lessons = (input.lessons ?? []).map((l) => l.trim()).filter(Boolean);
  const lessonsBlock =
    lessons.length > 0
      ? `<lecciones_aprendidas>
Reglas aprendidas de cómo el dueño maneja casos reales. Síguelas SIEMPRE:
${lessons.map((l) => `- ${l}`).join("\n")}
</lecciones_aprendidas>`
      : "";

  // Reglas escritas por el dueño en el panel. Se SUMAN al prompt generado —
  // el resto del cerebro (contexto, playbook, KB, anti-invento) queda intacto.
  const instructions = input.customInstructions?.trim();
  const instructionsBlock = instructions
    ? `<instrucciones_del_negocio>
Reglas adicionales del dueño del negocio. Síguelas SIEMPRE:
${instructions}
</instrucciones_del_negocio>`
    : "";

  // Botones tocables (opt-in, skill /botones): mismo patrón que
  // instructionsBlock — apagado = prompt BYTE-IDÉNTICO al de hoy. El runtime
  // (agent.ts + replies/sender.ts) traduce el marcador a botones nativos por
  // canal, o a lista numerada donde no hay soporte.
  const botonesBlock = input.buttonsEnabled
    ? `<botones>
Puedes ofrecer OPCIONES TOCABLES cuando le pidas al cliente una elección simple y
cerrada (confirmar una cita, elegir un servicio, sí/no, elegir horario). Para eso,
termina tu respuesta con una línea EXACTA con este formato:

[[botones: Opción uno | Opción dos | Opción tres]]

Reglas:
- Máximo 3 opciones, cada título de 20 caracteres o menos, claro y accionable.
- Úsalo SOLO cuando una elección corta ayuda de verdad; nunca en respuestas
  abiertas ni en cada mensaje — se siente robótico.
- El marcador va al FINAL, en su propia línea, una sola vez. El texto de arriba
  debe entenderse solo (los botones son un atajo, no el mensaje).
- Cuando el cliente toque un botón, su elección te llega como mensaje de texto
  normal: respóndele avanzando, sin repetir las opciones.
</botones>`
    : "";

  const contextoTemporal = input.today
    ? `<contexto_temporal>
Hoy es ${input.today}. Tu conocimiento de entrenamiento tiene OTRA fecha — ignórala.
Usa SIEMPRE esta fecha real para hablar de "hoy" o "mañana" con el cliente.
Cuando llames una tool de citas/horarios con una fecha relativa ("el viernes",
"el próximo martes", "mañana"), pasa las PALABRAS del cliente, no un YYYY-MM-DD
que hayas calculado tú. El sistema resuelve la fecha exacta y el día de la semana.
Solo manda YYYY-MM-DD si el cliente dio una fecha de calendario (día y mes).
</contexto_temporal>`
    : "";

  return TEMPLATE
    .replaceAll("{{LANGUAGE_INSTRUCTIONS}}", buildLanguageInstructions(input.language))
    .replaceAll("{{CONTEXTO_TEMPORAL}}", contextoTemporal)
    .replaceAll("{{BOT_NAME}}", input.botName)
    .replaceAll("{{BUSINESS_NAME}}", input.businessName)
    .replaceAll("{{BUSINESS_CONTEXT}}", input.businessContext)
    .replaceAll("{{TOOL_LIST}}", toolList)
    .replaceAll("{{NICHO_PLAYBOOK}}", input.nichoPlaybook ?? "")
    .replaceAll("{{LECCIONES}}", lessonsBlock)
    .replaceAll("{{BRAND_VOICE}}", brandVoiceBlock)
    .replaceAll("{{INSTRUCCIONES}}", instructionsBlock)
    .replaceAll("{{BOTONES}}", botonesBlock)
    .replaceAll("{{TONE_LINE}}", toneLine)
    .replaceAll("{{EXTRA_ESCALATION}}", extraEscalation)
    .replaceAll("{{EXTRA_STYLE}}", extraStyle);
}

export interface SystemPromptOverrides {
  tone?: string;
  extraEscalationKeywords?: string[];
  botName?: string;
  lessons?: string[];
  formattingRules?: string;
  brandVoice?: string;
  language?: string; // overrides env.BOT_LANGUAGE (e.g. "espejo")
  customInstructions?: string;
  buttonsEnabled?: boolean;
}

/** Fecha/hora actual legible + ISO en la zona del negocio (ancla "hoy"/"mañana"). */
export function currentDateLine(timeZone: string): string {
  const now = new Date();
  const legible = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  // en-CA formatea YYYY-MM-DD, útil como fecha ISO para las tools.
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return `${legible} (fecha ISO: ${iso}, zona horaria: ${timeZone})`;
}

export function systemPromptFromEnv(
  env: Env,
  toolNames: string[],
  businessContext: string,
  nichoPlaybook?: string,
  overrides?: SystemPromptOverrides,
): string {
  return renderSystemPrompt({
    botName: overrides?.botName ?? env.BOT_NAME,
    businessName: env.BUSINESS_NAME,
    language: overrides?.language?.trim() || env.BOT_LANGUAGE,
    businessContext,
    toolList: toolNames,
    nichoPlaybook,
    tone: overrides?.tone,
    extraEscalationKeywords: overrides?.extraEscalationKeywords,
    lessons: overrides?.lessons,
    formattingRules: overrides?.formattingRules,
    brandVoice: overrides?.brandVoice,
    customInstructions: overrides?.customInstructions,
    today: currentDateLine(businessTimeZone(env)),
    buttonsEnabled: overrides?.buttonsEnabled,
  });
}
