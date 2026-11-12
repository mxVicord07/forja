/**
 * Respaldo semanal de la base del bot a R2 (paso 9 del plan de Forja Pro, 12-nov-2026).
 *
 * Qué YA cubre Cloudflare sin código: D1 Time Travel, siempre encendido, restaura
 * la base a cualquier minuto de los últimos 30 días (plan de pago) con
 *   wrangler d1 time-travel restore <base> --timestamp=<unix>
 * Este respaldo cubre lo que Time Travel no: que se borre la base, guardar más de
 * 30 días y entregarle sus datos a un cliente que se va.
 *
 * - Apagado por omisión: solo con FEATURE_RESPALDO_SEMANAL="1" y un bucket MEDIA.
 * - Corre en el tick nocturno de los domingos (UTC).
 * - Tablas de negocio en JSON comprimido (gzip) en `respaldos/AAAA-MM-DD.json.gz`.
 * - Nunca guarda llaves: se excluyen los ajustes cuyo nombre parece secreto, el
 *   historial de ajustes (puede traer llaves viejas) y los enlaces mágicos.
 * - Conserva los 8 más recientes. Nunca tumba el resto de los trabajos nocturnos.
 */
import type { Env } from "../env";
import { Db } from "../db/client";

export const PREFIJO = "respaldos/";
export const CONSERVAR = 8;
export const MAX_FILAS = 50_000;

/** Tablas de negocio. Fuera a propósito: settings_history, magic_links, admin_emails y los contadores internos. */
export const TABLAS_RESPALDO = [
  "conversations", "messages", "leads", "tickets", "appointments", "appointment_change_requests",
  "conversation_insights", "customer_facts", "kb_docs", "documents", "payment_intents",
  "conv_labels", "survey_open_responses", "ad_origins", "settings",
] as const;

const NOMBRE_SENSIBLE = /(key|token|secret|password|contrase)/i;

export function respaldoActivo(env: Env): boolean {
  return env.FEATURE_RESPALDO_SEMANAL === "1" && Boolean(env.MEDIA);
}

/** Los domingos (UTC). */
export const tocaRespaldo = (now: Date) => now.getUTCDay() === 0;

export function claveRespaldo(now: Date): string {
  return `${PREFIJO}${now.toISOString().slice(0, 10)}.json.gz`;
}

/** Quita los ajustes cuyo nombre parece un secreto. */
export function filtrarSensibles(tabla: string, filas: Record<string, unknown>[]): Record<string, unknown>[] {
  if (tabla !== "settings") return filas;
  return filas.filter((f) => !NOMBRE_SENSIBLE.test(String(f.key ?? "")));
}

async function gzip(texto: string): Promise<ArrayBuffer> {
  const stream = new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

export interface ResultadoRespaldo {
  hecho: boolean;
  motivo?: string;
  clave?: string;
  filas?: Record<string, number>;
  truncadas?: string[];
  borrados?: string[];
}

export async function respaldoSemanal(env: Env, now: Date = new Date()): Promise<ResultadoRespaldo> {
  if (!respaldoActivo(env)) return { hecho: false, motivo: "apagado" };
  const db = new Db(env.DB);
  const tablas: Record<string, { filas: Record<string, unknown>[]; truncada: boolean }> = {};
  const filas: Record<string, number> = {};
  const truncadas: string[] = [];

  for (const t of TABLAS_RESPALDO) {
    let rows: Record<string, unknown>[];
    try {
      rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${t} LIMIT ?`, [MAX_FILAS + 1]);
    } catch {
      continue; // tabla que este bot no tiene (p. ej. ad_origins antes de su primer uso)
    }
    const truncada = rows.length > MAX_FILAS;
    if (truncada) {
      rows = rows.slice(0, MAX_FILAS);
      truncadas.push(t);
    }
    rows = filtrarSensibles(t, rows);
    tablas[t] = { filas: rows, truncada };
    filas[t] = rows.length;
  }

  const clave = claveRespaldo(now);
  const cuerpo = JSON.stringify({ version: 1, bot: env.BOT_NAME, creado: now.toISOString(), tablas });
  await env.MEDIA!.put(clave, await gzip(cuerpo), {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    customMetadata: { tablas: String(Object.keys(tablas).length), truncadas: truncadas.join(",") },
  });

  // Rotación: conserva los CONSERVAR más recientes (el nombre lleva la fecha, así que el orden alfabético es el cronológico).
  const lista = await env.MEDIA!.list({ prefix: PREFIJO });
  const claves = lista.objects.map((o) => o.key).filter((k) => /^respaldos\/\d{4}-\d{2}-\d{2}\.json\.gz$/.test(k)).sort();
  const borrar = claves.slice(0, Math.max(0, claves.length - CONSERVAR));
  for (const k of borrar) await env.MEDIA!.delete(k);

  return { hecho: true, clave, filas, truncadas, borrados: borrar };
}
