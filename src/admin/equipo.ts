import { Db } from "../db/client";

/**
 * Bitácora del panel (`panel_audit`) — porteo PARCIAL de `admin/equipo.ts` del
 * paquete Forja+ v1.0.76, solo la pieza que necesita `lib/actor.ts` para dejar
 * constancia de qué hizo cada persona desde Forja Inbox ("Beto pausó el bot",
 * "Ana cambió el tono"). El resto del archivo original — login de equipo con
 * roles, invitaciones, recuperación de contraseña, la tabla `panel_users`
 * completa — es la función `/equipo` (Forja+, Modo Agencia) y NO se portó en
 * esta pasada: fuera de alcance de integrar Forja Inbox. Si algún día se trae
 * `/equipo` completo, este archivo se reemplaza por el original íntegro.
 *
 * Sin migración: tabla auto-creada al primer uso (mismo patrón que Bóveda y
 * el resto del paquete original). Un bot que nunca usa la app no crea nada.
 */

export interface AuditRow {
  id: number;
  at: number;
  actor_id: string | null;
  actor_label: string;
  accion: string;
  detalle: string | null;
}

let ensured = false;

async function ensurePanelAuditTable(db: Db): Promise<void> {
  if (ensured) return;
  await db.run(
    `CREATE TABLE IF NOT EXISTS panel_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      actor_id TEXT, actor_label TEXT NOT NULL, accion TEXT NOT NULL, detalle TEXT)`,
  );
  await db.run("CREATE INDEX IF NOT EXISTS idx_panel_audit_at ON panel_audit(at)").catch(() => {});
  ensured = true;
}

/** Solo para tests: resetea el memo del CREATE TABLE. */
export function __resetEnsured(): void {
  ensured = false;
}

/** Deja constancia en la bitácora del panel. Best-effort: nunca tumba la acción llamante. */
export async function audit(
  db: Db,
  actor: { id?: string | null; label: string },
  accion: string,
  detalle?: string,
): Promise<void> {
  try {
    await ensurePanelAuditTable(db);
    await db.run(
      "INSERT INTO panel_audit (at, actor_id, actor_label, accion, detalle) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), actor.id ?? null, actor.label.slice(0, 120), accion.slice(0, 60), (detalle ?? "").slice(0, 500) || null],
    );
  } catch (e) {
    console.warn("[audit] no se pudo registrar:", e);
  }
}

export async function listAudit(db: Db, limit = 60): Promise<AuditRow[]> {
  await ensurePanelAuditTable(db);
  return db.all<AuditRow>("SELECT * FROM panel_audit ORDER BY at DESC LIMIT ?", [limit]);
}
