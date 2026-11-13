/**
 * Estado de WhatsApp de una conversación, para el panel (13-nov-2026).
 *
 * 1. Ventana: la de 24 h de Meta manda para el TEXTO LIBRE (ver wa-window.ts).
 *    Si el cliente llegó por un anuncio de clic a WhatsApp y el negocio contestó
 *    dentro de 24 h, Meta abre además una ventana de entrada gratis (72 h por
 *    omisión; configurable con WA_ENTRADA_GRATIS_HORAS porque Meta la ha
 *    cambiado): en ella las PLANTILLAS no se cobran, pero el texto libre sigue
 *    necesitando la ventana de 24 h. Por eso aquí solo se informa, no se abre
 *    el envío libre.
 * 2. Rechazos: YCloud acepta un mensaje y Meta lo rechaza después (evento
 *    `whatsapp.message.updated` con status "failed"). Forja deja una nota
 *    interna en el hilo de ese contacto con el motivo, una sola vez por mensaje.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { computeWindow, isWindowedChannel, type WaWindow } from "./wa-window";

const HORA = 3_600_000;

export function horasEntradaGratis(env: Pick<Env, "WA_ENTRADA_GRATIS_HORAS">): number {
  const n = Number(env.WA_ENTRADA_GRATIS_HORAS);
  return Number.isFinite(n) && n >= 24 && n <= 24 * 14 ? n : 72;
}

export interface EstadoVentana {
  ventana: WaWindow;
  /** Hasta cuándo las plantillas salen gratis por venir de un anuncio; null si no aplica o ya pasó. */
  gratisHasta: number | null;
}

/** null si el canal no tiene ventana (web, Telegram…). */
export async function estadoVentana(
  db: Db,
  conv: { id: string; channel: string; channel_user_id: string },
  env: Pick<Env, "WA_ENTRADA_GRATIS_HORAS">,
  now = Date.now(),
): Promise<EstadoVentana | null> {
  if (!isWindowedChannel(conv.channel, null)) return null;
  const u = await db.first<{ t: number | null }>(
    "SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'",
    [conv.id],
  );
  const ventana = computeWindow(u?.t ?? null, now);
  let gratisHasta: number | null = null;
  try {
    const ad = await db.first<{ first_seen_at: number; ctwa_clid: string | null; source_type: string | null }>(
      "SELECT first_seen_at, ctwa_clid, source_type FROM ad_origins WHERE conversation_id = ?",
      [conv.id],
    );
    if (ad && (ad.ctwa_clid || (ad.source_type ?? "").toLowerCase() === "ad")) {
      const resp = await db.first<{ t: number | null }>(
        "SELECT MIN(created_at) AS t FROM messages WHERE conversation_id = ? AND role IN ('assistant','owner') AND created_at >= ?",
        [conv.id, ad.first_seen_at],
      );
      if (resp?.t && resp.t - ad.first_seen_at <= 24 * HORA) {
        const hasta = resp.t + horasEntradaGratis(env) * HORA;
        if (hasta > now) gratisHasta = hasta;
      }
    }
  } catch {
    /* tabla ad_origins aún no creada: no vino de anuncio */
  }
  return { ventana, gratisHasta };
}

// ── Rechazos de entrega ──────────────────────────────────────────────────────

const MOTIVOS: Record<string, string> = {
  "131047": "pasaron más de 24 h desde el último mensaje del cliente; escríbele desde tu app o usa una plantilla",
  "131026": "el número no puede recibir el mensaje (no tiene WhatsApp, lo bloqueó o su app es muy vieja)",
  "131049": "Meta limitó los mensajes de marketing a esta persona para cuidar su experiencia",
  "131050": "la persona pidió dejar de recibir mensajes de marketing",
  "131051": "tipo de mensaje no soportado",
  "131048": "Meta frenó los envíos de este número por calidad (spam)",
  "130472": "el número forma parte de un experimento de Meta y no recibe marketing",
  "132001": "la plantilla no existe o no está aprobada en ese idioma",
};

export interface FalloEntrega { ycloudId: string; to: string; codigo: string; motivo: string; texto: string | null; cuando: number }

/** Lee un evento de YCloud; solo devuelve algo si es un mensaje que Meta no entregó. */
export function leerFallo(body: unknown): FalloEntrega | null {
  const e = body as { type?: string; whatsappMessage?: Record<string, any> } | null;
  if (e?.type !== "whatsapp.message.updated") return null;
  const m = e.whatsappMessage;
  if (!m || m.status !== "failed" || !m.id || !m.to) return null;
  const codigo = String(m.errorCode ?? m.error?.code ?? "");
  const crudo = String(m.errorMessage ?? m.error?.message ?? "").slice(0, 160);
  const texto = typeof m.text?.body === "string" ? m.text.body : m.template?.name ? `plantilla ${m.template.name}` : null;
  const cuando = Date.parse(m.updateTime ?? m.sendTime ?? m.createTime ?? "") || Date.now();
  return { ycloudId: String(m.id), to: String(m.to), codigo, motivo: MOTIVOS[codigo] ?? (crudo || "Meta no dio el motivo"), texto, cuando };
}

let ensured = false;
async function ensure(db: Db) {
  if (ensured) return;
  await db.run("CREATE TABLE IF NOT EXISTS wa_fallos (ycloud_id TEXT PRIMARY KEY, conversation_id TEXT, codigo TEXT, creado INTEGER NOT NULL)", []);
  ensured = true;
}
export function __resetWaEstado() { ensured = false; }

/** Variantes con las que Forja puede tener guardado el número (México con o sin el «1»). */
function variantes(to: string): string[] {
  const d = to.replace(/\D/g, "");
  const out = new Set([d]);
  if (/^52\d{10}$/.test(d)) out.add("521" + d.slice(2));
  if (/^521\d{10}$/.test(d)) out.add("52" + d.slice(3));
  return [...out];
}

/** Deja la nota en el hilo. Idempotente: YCloud reintenta y el mismo fallo no se anota dos veces. Nunca lanza. */
export async function anotarFallo(d1: D1Database, f: FalloEntrega): Promise<"anotado" | "repetido" | "sin_conversacion" | "error"> {
  try {
    const db = new Db(d1);
    await ensure(db);
    const ya = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM wa_fallos WHERE ycloud_id = ?", [f.ycloudId]);
    if (ya?.n) return "repetido";
    const tels = variantes(f.to);
    const conv = await db.first<{ id: string }>(
      `SELECT id FROM conversations WHERE channel = 'whatsapp' AND channel_user_id IN (${tels.map(() => "?").join(",")}) ORDER BY last_message_at DESC LIMIT 1`,
      tels,
    );
    await db.run("INSERT OR IGNORE INTO wa_fallos (ycloud_id, conversation_id, codigo, creado) VALUES (?,?,?,?)", [f.ycloudId, conv?.id ?? null, f.codigo, Date.now()]);
    if (!conv) return "sin_conversacion";
    const frag = f.texto ? ` («${f.texto.replace(/\s+/g, " ").slice(0, 70)}${f.texto.length > 70 ? "…" : ""}»)` : "";
    await new MessagesRepo(db).append(conv.id, "note", `⚠️ WhatsApp no entregó un mensaje${frag}: ${f.motivo}${f.codigo ? ` (código ${f.codigo})` : ""}.`, { createdAt: f.cuando });
    return "anotado";
  } catch (e) {
    console.error("[wa-estado] no se pudo anotar el fallo:", e instanceof Error ? e.message : e);
    return "error";
  }
}
