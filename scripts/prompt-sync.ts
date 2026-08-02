/**
 * Baja GET /admin/instruccion-maestra.md del bot desplegado y lo escribe en
 * FORJA/_context/instruccion-maestra.md (OneDrive, fuera de este repo — ver
 * docs/superpowers/specs/2026-08-01-instruccion-maestra-viva-design.md).
 *
 * Requiere en el entorno:
 *   DASHBOARD_PASSWORD   — la misma password del panel admin (Basic Auth)
 *   BOT_BASE_URL          — opcional, default al Worker desplegado de BIRevX
 *   PROMPT_SYNC_TARGET     — opcional, default a la ruta de OneDrive de este equipo
 *
 * Uso: pnpm prompt:sync
 */
import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

const BOT_BASE_URL = process.env.BOT_BASE_URL ?? "https://birevx-support-bot.victor-m-426.workers.dev";
const DEFAULT_TARGET =
  "/Users/mvico/Library/CloudStorage/OneDrive-BSEBI/08_Claude/Projects/CODE/FORJA/_context/instruccion-maestra.md";
const TARGET = process.env.PROMPT_SYNC_TARGET ?? DEFAULT_TARGET;

async function main() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    console.error("Falta DASHBOARD_PASSWORD en el entorno.");
    process.exit(1);
  }

  const auth = Buffer.from(`admin:${password}`, "utf-8").toString("base64");
  const res = await fetch(`${BOT_BASE_URL}/admin/instruccion-maestra.md`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (res.status !== 200) {
    console.error(`Respuesta ${res.status} — no se actualiza el archivo local (se conserva la versión previa).`);
    process.exit(1);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/markdown")) {
    console.error(`Content-Type inesperado (${contentType}) — no se actualiza el archivo local.`);
    process.exit(1);
  }

  const body = await res.text();

  // Escribir en el mismo directorio que TARGET para garantizar rename atómico (same-device).
  const tmpPath = path.join(path.dirname(TARGET), `.instruccion-maestra-${Date.now()}.tmp`);
  writeFileSync(tmpPath, body, "utf-8");
  try {
    renameSync(tmpPath, TARGET);
  } catch (e) {
    // Cross-device o permiso denegado — fallback a copy+delete (raro con la estrategia de mismo directorio).
    try {
      writeFileSync(TARGET, body, "utf-8");
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignorar errores al limpiar el temp file — es best-effort.
      }
    }
  }

  console.log(`✅ Instrucción maestra sincronizada: ${TARGET}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
