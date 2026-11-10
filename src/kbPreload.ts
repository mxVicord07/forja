import type { Env } from "./env";
import { consultaKb, type SearchKbResult } from "./tools/searchKb";

/**
 * Precarga de la base de conocimiento (I-018).
 *
 * El 31-oct, con 33 turnos en 30 días, `searchKb` se llamó 5 veces: el modelo
 * decide si buscar y casi siempre improvisa. Aquí la búsqueda deja de ser
 * opcional: antes de cada turno se consulta la KB con lo que escribió el
 * cliente y los pasajes que coinciden entran al contexto como un bloque más
 * (igual que la ficha del CRM). El modelo sigue pudiendo llamar searchKb para
 * afinar. Fail-soft: cualquier error o tardanza devuelve [] y el turno sigue
 * como antes.
 */

/** Pasajes con menos score que esto no se inyectan (searchKb ya dice que <0.7 no es un match útil). */
export const KB_PRELOAD_MIN_SCORE = 0.65;
export const KB_PRELOAD_TOP_K = 4;
export const KB_PRELOAD_MAX_PASSAGES = 3;
export const KB_PRELOAD_TIMEOUT_MS = 2500;
export const KB_PRELOAD_MAX_CHARS = 900;

const SOLO_CORTESIA = /^(hola|buen[oa]s?( d[ií]as| tardes| noches)?|gracias|ok(ay)?|va|vale|sí|si|no|perfecto|entendido|listo|hey|hi|hello|thanks?)[\s!.¡?¿,]*$/i;

/** ¿Vale la pena buscar? No para cortesías ni mensajes de una o dos palabras sueltas. */
export function debePrecargar(texto: string): boolean {
  const t = String(texto || "").trim();
  if (t.length < 12) return false;
  if (SOLO_CORTESIA.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length >= 3;
}

/** Los pasajes que pasan el umbral, del mejor al peor, sin repetir título, con tope. */
export function elegirPasajes(resultados: SearchKbResult[]): SearchKbResult[] {
  const vistos = new Set<string>();
  const out: SearchKbResult[] = [];
  for (const r of [...resultados].sort((a, b) => b.score - a.score)) {
    if (r.score < KB_PRELOAD_MIN_SCORE || !r.content?.trim()) continue;
    const clave = (r.title || r.content).trim().toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push(r);
    if (out.length >= KB_PRELOAD_MAX_PASSAGES) break;
  }
  return out;
}

const corto = (s: string) => {
  const t = s.trim();
  return t.length <= KB_PRELOAD_MAX_CHARS ? t : `${t.slice(0, KB_PRELOAD_MAX_CHARS).replace(/\s+\S*$/, "")}…`;
};

/** Bloque de sistema con los pasajes. Respeta la regla del prompt: no narrar la maquinaria interna. */
export function renderKbBlock(pasajes: SearchKbResult[]): string {
  const cuerpo = pasajes.map((p) => `${p.title ? `[${p.title}]\n` : ""}${corto(p.content)}`).join("\n\n");
  return [
    "<conocimiento>",
    "Esto es lo que dice tu información sobre lo que el cliente acaba de preguntar. Es tu fuente: si contradice lo que crees saber, mandan estos pasajes. Contesta con ellos en tus palabras, sin decir «según mi base de conocimiento» ni citar el título. Si lo que pregunta no está aquí ni lo sabes con certeza, no lo inventes: usa searchKb para afinar o escala.",
    "",
    cuerpo,
    "</conocimiento>",
  ].join("\n");
}

type Consulta = (env: Env, query: string, topK?: number) => Promise<SearchKbResult[]>;

/** Consulta la KB con el texto del cliente. Nunca lanza: error o timeout → []. */
export async function precargarKb(
  env: Env,
  texto: string,
  opts: { timeoutMs?: number; consulta?: Consulta } = {},
): Promise<SearchKbResult[]> {
  if ((env as { KB_PRELOAD?: string }).KB_PRELOAD === "off") return [];
  if (!debePrecargar(texto)) return [];
  const consulta = opts.consulta ?? consultaKb;
  const ms = opts.timeoutMs ?? KB_PRELOAD_TIMEOUT_MS;
  try {
    const resultados = await Promise.race([
      consulta(env, String(texto).slice(0, 500), KB_PRELOAD_TOP_K),
      new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error("kb preload timeout")), ms)),
    ]);
    return elegirPasajes(resultados);
  } catch (e) {
    console.warn("[kbPreload] falló (el turno sigue sin pasajes):", e instanceof Error ? e.message : e);
    return [];
  }
}
