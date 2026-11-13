/**
 * Borrador con IA para «A quién atender hoy» (panel de Leads).
 *
 * El texto fijo del Copiloto solo sabe el nombre y el tema. Este borrador se
 * redacta con lo que el dueño sabe de esa persona: las notas del chatter, las
 * actividades abiertas y la descripción de la oportunidad en Odoo (modo
 * «contexto» del flujo BRX_Forja_Seguimiento, solo lectura), más los últimos
 * mensajes de WhatsApp de esa conversación en Forja, incluidos los que el dueño
 * mandó desde su app (coexistencia).
 *
 * - Nunca se envía solo: abre la app del dueño con el texto para que lo edite.
 * - Se guarda con una HUELLA del contexto (fecha de edición de la oportunidad en
 *   Odoo + último mensaje de la conversación). Si cualquiera cambia, o pasan
 *   72 h, el borrador guardado deja de mostrarse y vuelve el botón: así el
 *   mensaje sigue a la conversación sin gastar IA en cada vista.
 * - Apagado por omisión: FEATURE_BORRADOR_IA="1" y CRM_SEGUIMIENTO_URL.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { workModel } from "../llm/work-model";

export const VIGENCIA_MS = 72 * 3_600_000;
const TIMEOUT_MS = 8000;
const MAX_TEXTO = 700;
const MENSAJES = 16;

export function borradorIaActivo(env: Env): boolean {
  return env.FEATURE_BORRADOR_IA === "1" && Boolean(env.CRM_SEGUIMIENTO_URL) && Boolean(env.DB);
}

export interface ContextoLead {
  lead: {
    id: number; tipo: string; titulo: string; quien: string; empresa: string | null; etapa: string | null;
    semaforo: string | null; codigo: string | null; ultimoContacto: string | null; canal: string | null;
    proximaCita: string | null; conversacion: string | null; descripcion: string | null;
  };
  actividades: { fecha: string | null; tipo: string | null; resumen: string | null; nota: string | null }[];
  notas: { fecha: string; autor: string | null; texto: string }[];
  huellaOdoo: string | null;
}

const s = (v: unknown, max = 600): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function normalizeContexto(data: unknown): ContextoLead | null {
  const d = data as Record<string, any> | null;
  if (!d || d.ok !== true || !d.lead || !Number.isFinite(Number(d.lead.id))) return null;
  const l = d.lead;
  return {
    lead: {
      id: Number(l.id), tipo: s(l.tipo, 20) ?? "prospecto", titulo: s(l.titulo, 160) ?? "", quien: s(l.quien, 80) ?? "", empresa: s(l.empresa, 80),
      etapa: s(l.etapa, 60), semaforo: s(l.semaforo, 160), codigo: s(l.codigo, 60), ultimoContacto: s(l.ultimo_contacto, 30), canal: s(l.canal, 30),
      proximaCita: s(l.proxima_cita, 30), conversacion: s(l.conversacion, 80), descripcion: s(l.descripcion, 800),
    },
    actividades: (Array.isArray(d.actividades) ? d.actividades : []).slice(0, 5).map((a: any) => ({ fecha: s(a?.fecha, 10), tipo: s(a?.tipo, 40), resumen: s(a?.resumen, 140), nota: s(a?.nota, 300) })),
    notas: (Array.isArray(d.notas) ? d.notas : []).filter((n: any) => s(n?.texto)).slice(0, 8).map((n: any) => ({ fecha: s(n.fecha, 10) ?? "", autor: s(n.autor, 60), texto: s(n.texto, 600)! })),
    huellaOdoo: s(d.huella_odoo, 40),
  };
}

export async function fetchContextoLead(env: Env, id: number): Promise<ContextoLead | null> {
  if (!env.CRM_SEGUIMIENTO_URL) return null;
  try {
    const res = await fetch(env.CRM_SEGUIMIENTO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contexto: id }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? normalizeContexto(await res.json()) : null;
  } catch {
    return null;
  }
}

/** Variantes del número tal como Forja lo guarda (México puede venir con o sin el «1» viejo). */
export function variantesTelefono(waUrl: string | null): string[] {
  const m = waUrl ? /wa\.me\/(\d{8,15})/.exec(waUrl) : null;
  if (!m) return [];
  const d = m[1];
  const out = new Set([d]);
  if (/^52\d{10}$/.test(d)) out.add("521" + d.slice(2));
  if (/^521\d{10}$/.test(d)) out.add("52" + d.slice(3));
  return [...out];
}

export interface Hilo { conversationId: string; ultimoId: string | null; mensajes: { role: string; content: string; created_at: number }[] }

/** La conversación de Forja de esa persona: la ligada en Odoo o, si no, la de WhatsApp con su número. */
export async function hiloDe(db: Db, conversacion: string | null, waPropio: string | null, n = MENSAJES): Promise<Hilo | null> {
  const tels = variantesTelefono(waPropio);
  if (!conversacion && !tels.length) return null;
  const marcas = tels.map(() => "?").join(",");
  const conv = await db.first<{ id: string }>(
    `SELECT id FROM conversations WHERE id = ?${tels.length ? ` OR (channel = 'whatsapp' AND channel_user_id IN (${marcas}))` : ""} ORDER BY last_message_at DESC LIMIT 1`,
    [conversacion ?? "", ...tels],
  );
  if (!conv) return null;
  const mensajes = await db.all<{ id: string; role: string; content: string; created_at: number }>(
    `SELECT * FROM (SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? AND role IN ('user','assistant','owner','note') AND content IS NOT NULL AND content <> '' ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`,
    [conv.id, n],
  );
  return { conversationId: conv.id, ultimoId: mensajes.length ? mensajes[mensajes.length - 1].id : null, mensajes };
}

export const huella = (huellaOdoo: string | null, ultimoId: string | null) => `${huellaOdoo ?? "-"}|${ultimoId ?? "-"}`;

// ── Guardado ─────────────────────────────────────────────────────────────────
let ensured = false;
async function ensure(db: Db) {
  if (ensured) return;
  await db.run(`CREATE TABLE IF NOT EXISTS borradores_ia (lead_id INTEGER PRIMARY KEY, huella TEXT NOT NULL, texto TEXT NOT NULL, modelo TEXT, creado INTEGER NOT NULL)`, []);
  ensured = true;
}
export function __resetBorradorIa() { ensured = false; }

export interface BorradorGuardado { leadId: number; huella: string; texto: string; modelo: string | null; creado: number }

export async function guardarBorrador(db: Db, b: BorradorGuardado) {
  await ensure(db);
  await db.run(`INSERT INTO borradores_ia (lead_id, huella, texto, modelo, creado) VALUES (?,?,?,?,?)
    ON CONFLICT(lead_id) DO UPDATE SET huella = excluded.huella, texto = excluded.texto, modelo = excluded.modelo, creado = excluded.creado`, [b.leadId, b.huella, b.texto, b.modelo, b.creado]);
}

/**
 * Los borradores que siguen valiendo para estas tarjetas: misma huella (nada cambió en
 * Odoo ni en la conversación) y menos de 72 h. Los demás no se muestran.
 */
export async function borradoresVigentes(
  db: Db,
  filas: { id: number; huellaOdoo: string | null; conversacion: string | null; waPropio: string | null }[],
  now = Date.now(),
): Promise<Map<number, BorradorGuardado>> {
  const out = new Map<number, BorradorGuardado>();
  if (!filas.length) return out;
  await ensure(db);
  const guardados = await db.all<{ lead_id: number; huella: string; texto: string; modelo: string | null; creado: number }>(
    `SELECT * FROM borradores_ia WHERE lead_id IN (${filas.map(() => "?").join(",")})`, filas.map((f) => f.id));
  for (const g of guardados) {
    if (now - g.creado > VIGENCIA_MS) continue;
    const f = filas.find((x) => x.id === g.lead_id)!;
    const hilo = await hiloDe(db, f.conversacion, f.waPropio, 1).catch(() => null);
    if (huella(f.huellaOdoo, hilo?.ultimoId ?? null) !== g.huella) continue;
    out.set(g.lead_id, { leadId: g.lead_id, huella: g.huella, texto: g.texto, modelo: g.modelo, creado: g.creado });
  }
  return out;
}

// ── Redacción ────────────────────────────────────────────────────────────────
export function systemPrompt(env: Env): string {
  const quien = (env.DUENO_NOMBRE ?? "").trim() || "el dueño";
  return [
    `Redactas UN mensaje de WhatsApp que ${quien}, de ${env.BUSINESS_NAME}, va a revisar y mandar él mismo desde su app a un prospecto o cliente. Escribes en primera persona, como ${quien}.`,
    "Reglas:",
    "- Español de México, cercano y profesional, como dueño de negocio. Sin tecnicismos ni frases de vendedor.",
    "- Corto: dos o tres oraciones, menos de 350 caracteres. Un solo mensaje. Puede llevar saltos de línea.",
    "- Retoma lo último concreto que pasó con esta persona (lo que se platicó, lo que quedó pendiente, lo que ella preguntó) y cierra con un siguiente paso claro y fácil de contestar.",
    "- Si ya hay conversación reciente, no te vuelvas a presentar. Si nunca han hablado o pasó mucho tiempo, preséntate en media línea.",
    "- No inventes nada que no esté en el contexto. No menciones precios, montos, descuentos ni plazos. No prometas resultados.",
    "- Las notas internas, el semáforo, las etapas y los códigos son para que entiendas la situación: nunca los cites ni digas que usas un CRM o un sistema.",
    "- Si el contexto dice que esta persona pidió no ser contactada o que hay que esperar, escribe solo: NO_ESCRIBIR",
    "Devuelve solo el texto del mensaje, sin comillas, sin explicación y sin firma.",
  ].join("\n");
}

const ROL: Record<string, string> = { user: "Cliente", owner: "Yo (desde mi app)", assistant: "Asistente automático", note: "Nota interna" };

export function contextoTexto(c: ContextoLead, hilo: Hilo | null, hoy: string, tz: string): string {
  const fecha = (ms: number) => new Intl.DateTimeFormat("es-MX", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(ms));
  const l = c.lead;
  const partes = [
    `Hoy es ${hoy}.`,
    `Persona: ${l.quien || "(sin nombre)"}${l.empresa && l.empresa !== l.quien ? ` · ${l.empresa}` : ""}`,
    `Oportunidad: ${l.titulo}${l.etapa ? ` · etapa ${l.etapa}` : ""}`,
    l.semaforo ? `Situación de contacto: ${l.semaforo}` : "",
    l.ultimoContacto ? `Último contacto registrado: ${l.ultimoContacto.slice(0, 10)}${l.canal ? ` por ${l.canal}` : ""}` : "Sin contacto registrado.",
    l.proximaCita ? `Próxima cita: ${l.proximaCita.slice(0, 16)}` : "",
    l.descripcion ? `Descripción interna: ${l.descripcion}` : "",
    c.actividades.length ? "Pendientes abiertos:\n" + c.actividades.map((a) => `- ${a.fecha ?? ""} ${a.tipo ?? ""}: ${a.resumen ?? ""}${a.nota ? ` (${a.nota})` : ""}`).join("\n") : "Sin pendientes abiertos.",
    c.notas.length ? "Historial en el CRM (más reciente primero):\n" + c.notas.map((n) => `- ${n.fecha}${n.autor ? ` ${n.autor}` : ""}: ${n.texto}`).join("\n") : "Sin historial en el CRM.",
    hilo && hilo.mensajes.length
      ? "Últimos mensajes de WhatsApp (del más viejo al más nuevo):\n" + hilo.mensajes.map((m) => `- [${fecha(m.created_at)}] ${ROL[m.role] ?? m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")
      : "Sin mensajes de WhatsApp guardados.",
  ];
  return partes.filter(Boolean).join("\n");
}

/** Limpia la respuesta del modelo: sin comillas envolventes, sin preámbulo y con tope de largo. */
export function limpiarBorrador(t: string): string | null {
  let x = t.trim().replace(/^["“«']+|["”»']+$/g, "").trim();
  if (!x || /^NO_ESCRIBIR\b/.test(x)) return null;
  if (x.length > MAX_TEXTO) x = x.slice(0, MAX_TEXTO).replace(/\s+\S*$/, "") + "…";
  return x;
}

export type ResultadoRedaccion =
  | { ok: true; borrador: BorradorGuardado }
  | { ok: false; motivo: "apagado" | "sin_contexto" | "no_escribir" | "llm_failed" };

export async function redactarBorrador(
  env: Env,
  leadId: number,
  waPropio: string | null,
  opts: { now?: Date; tz?: string; generar?: (system: string, prompt: string) => Promise<{ text: string; modelo: string }> } = {},
): Promise<ResultadoRedaccion> {
  if (!borradorIaActivo(env)) return { ok: false, motivo: "apagado" };
  const db = new Db(env.DB);
  const ctx = await fetchContextoLead(env, leadId);
  if (!ctx) return { ok: false, motivo: "sin_contexto" };
  const cod = ctx.lead.codigo ?? "";
  if (cod.startsWith("no_tocar:")) return { ok: false, motivo: "no_escribir" };
  const hilo = await hiloDe(db, ctx.lead.conversacion, waPropio).catch(() => null);
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? "America/Mexico_City";
  const hoy = new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  const generar = opts.generar ?? (async (system: string, prompt: string) => {
    const llm = await workModel(env, "smart", "copilot");
    const r = await llm.generate({ system, messages: [{ role: "user", content: prompt }] });
    return { text: r.text, modelo: llm.modelId };
  });
  let res: { text: string; modelo: string };
  try {
    res = await generar(systemPrompt(env), contextoTexto(ctx, hilo, hoy, tz));
  } catch {
    return { ok: false, motivo: "llm_failed" };
  }
  const texto = limpiarBorrador(res.text);
  if (!texto) return { ok: false, motivo: "no_escribir" };
  const b: BorradorGuardado = { leadId, huella: huella(ctx.huellaOdoo, hilo?.ultimoId ?? null), texto, modelo: res.modelo, creado: now.getTime() };
  await guardarBorrador(db, b);
  return { ok: true, borrador: b };
}
