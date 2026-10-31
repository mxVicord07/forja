/**
 * Chat y formulario del SITIO WEB del negocio (producción, no demo). Diseño:
 * Consultor BIRevX AAIA/04_Documentos_Internos/BENCHMARK_Sitio_Neil-IA_2026-10-30.md, fase 1.
 *
 * A diferencia del Modo Demo (src/demo.ts), esto vive en el bot de producción,
 * así que se cuida igual que una llave de IA expuesta:
 *  - Apagado si no existe WEB_CHAT_ORIGINS; solo responde (CORS) a esos orígenes
 *    exactos y rechaza un POST de cualquier otro.
 *  - El visitante debe aceptar el aviso de privacidad antes de escribir.
 *  - Topes: turnos por sesión (como el demo), turnos web por día (costo total)
 *    y envíos del formulario por IP por hora.
 *
 * El chat reusa el canal `web` y el pipeline completo del agente (ficha del
 * CRM, captureLead, resumen a Odoo). El formulario entra como un lead más:
 * D1 primero (la reconciliación horaria reintenta si n8n falla) y después el
 * Upsert de Odoo con canal "web".
 */
import type { Context, Hono } from "hono";
import type { Env } from "./env";
import { Db } from "./db/client";
import { LeadsRepo } from "./db/leads";
import { exportLeadToOdoo } from "./tools/leadExport";
import { notifyOwner } from "./tools/handoffHuman";
import { demoTurnsUsed, demoOverLimit } from "./demo";
import { chunkReply } from "./replies/chunker";
import { extraeBotones, botonesATexto } from "./replies/sender";

/** Turnos de visitantes web en 24 h, sumando todas las sesiones (tope de costo). */
const MAX_WEB_TURNS_PER_DAY = 400;
/** Envíos del formulario por IP por hora. */
const MAX_LEADS_PER_IP_HOUR = 5;
const MAX_BUDGET = 300_000;
/** Burbujas máximas por respuesta en la web (WhatsApp usa 3). */
const WEB_MAX_BURBUJAS = 6;

/**
 * Una lista que el modelo escribe en una sola línea ("1. A 2. B 3. C") sale
 * como una opción por burbuja. Solo actúa si ya hay un "1." y un "2.", para
 * no cortar un número suelto dentro de una frase.
 */
export function separarLista(texto: string): string {
  if (!/(^|\s)1\.\s/.test(texto) || !/\s2\.\s/.test(texto)) return texto;
  return texto.replace(/\s+(\d{1,2})\.\s+(?=\S)/g, "\n\n$1. ");
}

export function allowedOrigin(env: Env, origin: string | null | undefined): string | null {
  if (!origin || !env.WEB_CHAT_ORIGINS) return null;
  const lista = env.WEB_CHAT_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  return lista.includes(origin) ? origin : null;
}

export interface WebLead {
  name: string;
  email: string;
  whatsapp: string;
  company: string;
  budget: number;
  message: string;
  lang: string;
  source: string;
}

export type WebLeadCheck = { ok: true; lead: WebLead } | { ok: false; error: string };

export function validateWebLead(body: unknown): WebLeadCheck {
  const b = (body ?? {}) as Record<string, unknown>;
  const txt = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  // Campo trampa: invisible para personas, los bots lo llenan.
  if (txt(b.website, 200)) return { ok: false, error: "spam" };
  if (b.consent !== true) return { ok: false, error: "consent" };
  const name = txt(b.name, 80);
  if (!name) return { ok: false, error: "name" };
  const email = txt(b.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "email" };
  const whatsapp = String(b.whatsapp ?? "").replace(/\D/g, "");
  if (whatsapp.length !== 10) return { ok: false, error: "whatsapp" };
  const budgetRaw = Number(b.budget);
  const budget = Number.isFinite(budgetRaw) ? Math.min(Math.max(Math.round(budgetRaw), 0), MAX_BUDGET) : 0;
  return {
    ok: true,
    lead: {
      name,
      email,
      whatsapp,
      company: txt(b.company, 120),
      budget,
      message: txt(b.message, 2000),
      lang: txt(b.lang, 5) || "es",
      source: txt(b.source, 30) || "contacto",
    },
  };
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Cuenta y registra un envío por IP (hash, nunca la IP en claro). true = dentro del tope. */
async function underIpLimit(db: Db, ip: string, now: number): Promise<boolean> {
  await db.run("CREATE TABLE IF NOT EXISTS web_lead_hits (ip_hash TEXT NOT NULL, at INTEGER NOT NULL)", []);
  const ipHash = await sha256(`forja-web:${ip}`);
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM web_lead_hits WHERE ip_hash = ? AND at > ?",
    [ipHash, now - 60 * 60 * 1000],
  );
  if ((row?.n ?? 0) >= MAX_LEADS_PER_IP_HOUR) return false;
  await db.run("INSERT INTO web_lead_hits (ip_hash, at) VALUES (?, ?)", [ipHash, now]);
  return true;
}

const pesos = (n: number) => `$${n.toLocaleString("en-US")} MXN`;

export async function handleWebLead(
  env: Env,
  check: { ok: true; lead: WebLead },
  ip: string,
  now: number = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  if (!(await underIpLimit(db, ip, now))) return { ok: false, error: "rate" };

  const l = check.lead;
  // El Upsert usa el intent como título de la oportunidad: corto y reconocible
  // en el pipeline. El mensaje completo va en las notas (descripción).
  const intent = `Sitio web · ${l.company || l.name}`.slice(0, 120);
  const notes = [
    l.company ? `Empresa y giro: ${l.company}` : null,
    `Presupuesto para automatizar: ${l.budget > 0 ? pesos(l.budget) : "no lo sabe aún"}`,
    `Formulario del sitio (${l.source}, ${l.lang})`,
    l.message ? `\n${l.message}` : null,
  ].filter(Boolean).join("\n");
  const contact = `${l.whatsapp} / ${l.email}`;

  const leads = new LeadsRepo(db);
  const leadId = await leads.create({
    conversationId: null,
    name: l.name,
    contact,
    channelUserId: null,
    intent,
    notes,
    metadata: { channel: "web", source: l.source, budget: l.budget, company: l.company },
  });

  const { exported, externalId } = await exportLeadToOdoo(env, {
    leadId, conversationId: null, name: l.name, contact, intent, notes, channel: "web",
  });
  if (exported) {
    await leads.setExported(leadId, "odoo", externalId!).catch((e) => console.error("[webchat] setExported:", e));
  }

  await notifyOwner(env, {
    reason: "Nuevo prospecto desde el sitio web",
    summary: `${l.name}${l.company ? ` (${l.company})` : ""} · WhatsApp ${l.whatsapp} · ${l.email}\n` +
      `Presupuesto: ${l.budget > 0 ? pesos(l.budget) : "no lo sabe aún"}\n\n${l.message || "(sin mensaje)"}` +
      (exported ? "" : "\n\n(Odoo no respondió; se reintenta solo en la próxima hora.)"),
    ticketId: `web:${leadId}`,
  }).catch((e) => console.error("[webchat] notifyOwner:", e));

  return { ok: true };
}

/** Respuestas con CORS para el origen permitido (y solo ese). */
function withCors(res: Response, origin: string): Response {
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.set("Vary", "Origin");
  return out;
}

export function registerWebRoutes(
  app: Hono<{ Bindings: Env }>,
  toAgent: (c: Context<{ Bindings: Env }>) => Promise<Response>,
): void {
  app.options("/web/*", (c) => {
    const origin = allowedOrigin(c.env, c.req.header("Origin"));
    if (!origin) return c.body(null, 204);
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    });
  });

  // Puerta común: apagado sin WEB_CHAT_ORIGINS; origen distinto → 403.
  const puerta = (c: Context<{ Bindings: Env }>): string | Response => {
    if (!c.env.WEB_CHAT_ORIGINS) return c.json({ ok: false, error: "off" }, 404);
    const origin = allowedOrigin(c.env, c.req.header("Origin"));
    return origin ?? c.json({ ok: false, error: "origin" }, 403);
  };

  app.post("/web/lead", async (c) => {
    const origin = puerta(c);
    if (typeof origin !== "string") return origin;
    const check = validateWebLead(await c.req.json().catch(() => ({})));
    // El spam recibe un "ok" para no enseñarle al bot qué lo delató.
    if (!check.ok) return withCors(c.json(check.error === "spam" ? { ok: true } : check, check.error === "spam" ? 200 : 400), origin);
    const ip = c.req.header("CF-Connecting-IP") ?? "sin-ip";
    const r = await handleWebLead(c.env, check, ip);
    return withCors(c.json(r, r.ok ? 200 : 429), origin);
  });

  app.post("/web/chat/send", async (c) => {
    const origin = puerta(c);
    if (typeof origin !== "string") return origin;
    const body = (await c.req.raw.clone().json().catch(() => ({}))) as { sessionId?: string; consent?: boolean };
    if (body.consent !== true) return withCors(c.json({ ok: false, error: "consent" }, 400), origin);
    const sid = String(body.sessionId ?? "").slice(0, 64);
    if (sid && demoOverLimit(await demoTurnsUsed(c.env, sid))) {
      return withCors(c.json({ ok: false, error: "limit" }, 429), origin);
    }
    const hoy = await new Db(c.env.DB).first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.channel = 'web' AND m.role = 'user' AND m.created_at > ?`,
      [Date.now() - 24 * 60 * 60 * 1000],
    );
    if ((hoy?.n ?? 0) >= MAX_WEB_TURNS_PER_DAY) return withCors(c.json({ ok: false, error: "busy" }, 429), origin);
    return withCors(await toAgent(c), origin);
  });

  app.get("/web/chat/poll", async (c) => {
    const origin = puerta(c);
    if (typeof origin !== "string") return origin;
    const sessionId = (c.req.query("session") ?? "").slice(0, 64);
    const after = Number(c.req.query("after") ?? 0) || 0;
    if (!sessionId) return withCors(c.json({ ok: false, error: "missing_session" }, 400), origin);
    const db = new Db(c.env.DB);
    const conv = await db.first<{ id: string }>(
      "SELECT id FROM conversations WHERE channel = 'web' AND channel_user_id = ? LIMIT 1",
      [sessionId],
    );
    if (!conv) return withCors(c.json({ ok: true, messages: [] }), origin);
    // Lo que escribe el dueño desde el panel (rol owner) también llega al visitante.
    const rows = await db.all<{ role: string; content: string; created_at: number }>(
      `SELECT role, content, created_at FROM messages
        WHERE conversation_id = ? AND created_at > ? AND role IN ('assistant', 'owner')
        ORDER BY created_at ASC LIMIT 20`,
      [conv.id, after],
    );
    // Igual que en WhatsApp: la respuesta del bot sale en burbujas
    // (chunkReply) y sin marcadores de botones, que en la web van como lista.
    // Todas las burbujas de un mensaje comparten su `at`: el cursor avanza
    // por mensaje, así que no se repiten ni se pierden.
    const messages = rows.flatMap((r) => {
      if (r.role !== "assistant") return [{ text: r.content, at: r.created_at }];
      const ext = extraeBotones(chunkReply(separarLista(r.content), WEB_MAX_BURBUJAS));
      const partes = ext.buttons?.length ? [...ext.chunks, botonesATexto(ext.buttons)] : ext.chunks;
      return partes.filter((p) => p.trim()).map((text) => ({ text, at: r.created_at }));
    });
    return withCors(c.json({ ok: true, messages }), origin);
  });
}
