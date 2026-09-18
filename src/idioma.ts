/**
 * Idiomas que el dueño puede elegir para el bot desde el panel o Forja Inbox.
 *
 * Porteo RECORTADO del paquete Forja+ v1.0.76: se toman los códigos +
 * descripciones naturales (`descripcionIdioma`, la mejora real: el prompt
 * dice "español de España, usa vosotros, evita mexicanismos" en vez del
 * código crudo "es-ES") y el valor especial `ESPEJO`. NO se porta el patrón
 * de caché por isolate (`idiomaEfectivo`/`applyLanguage`/`espejaAlCliente`):
 * este fork no lo necesita — `settings-loader.ts` ya relee `bot_language` de
 * D1 en cada `resolveAgentConfig()`, sin una capa de caché/mutación de env
 * aparte que mantener sincronizada. `bustIdiomaCache` queda como no-op para
 * que el código que lo llama (api-maintenance.ts, tras un PATCH) compile
 * igual — no hay nada que invalidar.
 */

/** Los idiomas que el dueño puede elegir en el panel. */
export const IDIOMAS = {
  "es-419": {
    etiqueta: "Español (Latinoamérica)",
    // Lo que se le inyecta al prompt en {{LANGUAGE_INSTRUCTIONS}}.
    prompt: "español latinoamericano (de tú, natural y cercano; NUNCA uses 'vosotros')",
  },
  "es-ES": {
    etiqueta: "Español (España)",
    prompt:
      "español de España (usa 'vosotros' cuando hables en plural y expresiones de allá como 'vale'; NO uses mexicanismos como 'órale', 'ahorita' o 'platicar')",
  },
  en: {
    etiqueta: "English",
    prompt: "English",
  },
  "pt-BR": {
    etiqueta: "Português (Brasil)",
    prompt: "português do Brasil",
  },
} as const;

export type CodigoIdioma = keyof typeof IDIOMAS;

/** "Espeja al cliente": el bot detecta y espeja el idioma del cliente turno a
 *  turno, en vez de fijarse a uno solo. Mismo valor especial que ya usaba
 *  `buildLanguageInstructions` en system-prompt.ts antes de este porteo. */
export const ESPEJO = "espejo" as const;
export type OpcionIdioma = CodigoIdioma | typeof ESPEJO;

export function esCodigoValido(v: unknown): v is CodigoIdioma {
  return typeof v === "string" && v in IDIOMAS;
}

/**
 * Traduce lo que haya en `bot_language`/`BOT_LANGUAGE` a una descripción
 * natural para el prompt.
 *
 * Acepta códigos nuevos ("es-ES") y lo que ya traen los bots instalados
 * ("es-MX", "es", "en-US"…). Si no reconoce nada, devuelve el valor tal cual:
 * un bot con `BOT_LANGUAGE="catalán"` seguirá hablando catalán en vez de que
 * se lo cambiemos por debajo.
 */
export function descripcionIdioma(valor: string): string {
  const v = (valor || "").trim();
  if (esCodigoValido(v)) return IDIOMAS[v].prompt;

  const bajo = v.toLowerCase();
  if (bajo === "es-es" || bajo === "es_es") return IDIOMAS["es-ES"].prompt;
  if (bajo.startsWith("pt")) return IDIOMAS["pt-BR"].prompt;
  if (bajo.startsWith("en")) return IDIOMAS.en.prompt;
  // es, es-MX, es-419, es-CO… — lo que traen hoy los bots instalados.
  if (bajo.startsWith("es")) return IDIOMAS["es-419"].prompt;
  return v || IDIOMAS["es-419"].prompt;
}

/** No-op en este fork (ver comentario de cabecera) — existe para que
 *  api-maintenance.ts compile igual que el paquete original tras un PATCH
 *  de idioma. */
export function bustIdiomaCache(_next?: string | null): void {
  // nada que invalidar: settings-loader.ts relee D1 en cada resolución
}
