/**
 * Origen publicitario de una conversación (paso 2 del plan de Forja Pro, 12-nov-2026).
 *
 * Cuando alguien escribe desde un anuncio con clic a WhatsApp, el primer mensaje
 * trae un objeto `referral` con el identificador del clic (`ctwa_clid`) y datos
 * del anuncio. Hoy Forja lo descartaba, así que no se podía medir ninguna
 * campaña. Aquí se guarda el PRIMER origen de cada conversación (primer toque
 * gana) y se manda con el prospecto a Odoo.
 *
 * [NO VERIFICADO con tráfico real de YCloud]: su documentación pública solo
 * confirma `ctwa_clid`. Por eso el lector acepta los dos estilos de nombre
 * (snake_case de Meta y camelCase de YCloud). En cuanto llegue el primer
 * mensaje real desde un anuncio, capturarlo como fixture
 * (docs/superpowers/specs/ycloud-payloads-capturados.json) y ajustar.
 *
 * Tabla `ad_origins` auto-creada al primer uso (mismo patrón que panel_audit):
 * aditiva, sin migración manual. Nunca tumba la entrada de un mensaje.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { Db } from "../db/client";

export interface AdReferral {
  ctwaClid: string | null;
  sourceId: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
}

const MAX = { id: 128, url: 500, texto: 200 } as const;

function campo(r: Record<string, unknown>, nombres: string[], max: number): string | null {
  for (const n of nombres) {
    const v = r[n];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, max);
    if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  }
  return null;
}

/** Lee el `referral` de un mensaje entrante. null si no viene de un anuncio (sin clic ni id de anuncio). */
export function extractAdReferral(raw: unknown): AdReferral | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ref: AdReferral = {
    ctwaClid: campo(r, ["ctwa_clid", "ctwaClid"], MAX.id),
    sourceId: campo(r, ["source_id", "sourceId"], MAX.id),
    sourceType: campo(r, ["source_type", "sourceType"], 32),
    sourceUrl: (() => {
      const u = campo(r, ["source_url", "sourceUrl"], MAX.url);
      return u && /^https?:\/\//i.test(u) ? u : null;
    })(),
    headline: campo(r, ["headline"], MAX.texto),
  };
  return ref.ctwaClid || ref.sourceId ? ref : null;
}

export interface AdOriginRow extends AdReferral {
  conversation_id: string;
  channel: string;
  first_seen_at: number;
}

let ensured = false;
async function ensureTable(db: Db): Promise<void> {
  if (ensured) return;
  await db.run(
    `CREATE TABLE IF NOT EXISTS ad_origins (
      conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL,
      ctwa_clid TEXT, source_id TEXT, source_type TEXT, source_url TEXT, headline TEXT,
      first_seen_at INTEGER NOT NULL)`,
  );
  ensured = true;
}

/** Solo para tests: resetea el memo del CREATE TABLE. */
export function __resetAdOriginsEnsured(): void {
  ensured = false;
}

export class AdOriginsRepo {
  constructor(private readonly db: Db) {}

  /** Guarda el origen si la conversación aún no tiene uno (primer toque gana). */
  async recordFirst(conversationId: string, channel: string, ref: AdReferral, now = Date.now()): Promise<void> {
    await ensureTable(this.db);
    await this.db.run(
      `INSERT OR IGNORE INTO ad_origins
         (conversation_id, channel, ctwa_clid, source_id, source_type, source_url, headline, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [conversationId, channel, ref.ctwaClid, ref.sourceId, ref.sourceType, ref.sourceUrl, ref.headline, now],
    );
  }

  async get(conversationId: string): Promise<AdOriginRow | null> {
    await ensureTable(this.db);
    const row = await this.db.first<{
      conversation_id: string; channel: string; ctwa_clid: string | null; source_id: string | null;
      source_type: string | null; source_url: string | null; headline: string | null; first_seen_at: number;
    }>("SELECT * FROM ad_origins WHERE conversation_id = ?", [conversationId]);
    if (!row) return null;
    return {
      conversation_id: row.conversation_id, channel: row.channel, first_seen_at: row.first_seen_at,
      ctwaClid: row.ctwa_clid, sourceId: row.source_id, sourceType: row.source_type, sourceUrl: row.source_url, headline: row.headline,
    };
  }
}

/** Best-effort: registra el origen y nunca lanza (la entrada del mensaje no debe depender de esto). */
export async function recordAdOrigin(d1: D1Database, conversationId: string, channel: string, ref: AdReferral | undefined): Promise<void> {
  if (!ref) return;
  try {
    await new AdOriginsRepo(new Db(d1)).recordFirst(conversationId, channel, ref);
  } catch (e) {
    console.warn("[ad-origin] no se pudo guardar el origen del anuncio:", e);
  }
}
