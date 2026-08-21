// URL firmada de salida: cómo un documento sale de R2 (privado) hacia un
// proveedor de canal (WhatsApp/Meta necesitan una URL pública que ELLOS
// descarguen; Telegram acepta directo una URL). Mismo patrón HMAC+expiración
// que ya usan los proxies de media ENTRANTE (src/channels/whatsapp.ts,
// ycloud.ts) — invertido: ahí protegían la descarga de lo que llegó, acá
// protegen la publicación de lo que compartimos.
import { hmacHex, timingSafeEqual } from "../channels/shared";
import type { Env } from "../env";

const URL_TTL_MS = 30 * 60 * 1000; // 30 min: tiempo de sobra para que el proveedor la descargue, incluso con reintentos.

/**
 * Secreto para firmar. Sin una var dedicada, el reindex de KB (KB_REINDEX_TOKEN)
 * ya es un secreto server-only garantizado en todo despliegue existente —
 * mismo patrón de fallback que WHATSAPP_APP_SECRET → META_APP_SECRET en
 * shared.ts, para no exigirle al dueño un secreto nuevo antes de poder
 * probar la feature.
 */
function signingSecret(env: Env): string {
  return env.FILES_SIGNING_SECRET || env.KB_REINDEX_TOKEN || "";
}

/** URL pública firmada de un documento (o null si falta secret/base). */
export async function signedFileUrl(docId: string, env: Env, origin: string): Promise<string | null> {
  const secret = signingSecret(env);
  const base = (origin || env.DASHBOARD_BASE_URL || "").replace(/\/$/, "");
  if (!secret || !base) return null;
  const exp = Date.now() + URL_TTL_MS;
  const sig = await hmacHex(secret, `${docId}.${exp}`);
  return `${base}/files/${encodeURIComponent(docId)}?exp=${exp}&sig=${sig}`;
}

/** Verifica exp+sig de una petición a /files/:id. Fail-closed ante cualquier duda. */
export async function verifyFileUrl(
  docId: string,
  exp: string | null,
  sig: string | null,
  env: Env,
): Promise<boolean> {
  const secret = signingSecret(env);
  const expNum = Number(exp);
  if (!secret || !exp || !sig || !Number.isFinite(expNum)) return false;
  if (Date.now() > expNum) return false;
  const expected = await hmacHex(secret, `${docId}.${exp}`);
  return timingSafeEqual(expected, sig);
}
