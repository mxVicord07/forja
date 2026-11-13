/**
 * Acceso por persona al panel con Cloudflare Access (paso 8 del plan de Forja Pro, 13-nov-2026).
 *
 * Cloudflare Access pide el correo y un código antes de dejar pasar a /admin y
 * manda un token firmado (JWT RS256) en el encabezado `Cf-Access-Jwt-Assertion`.
 * Aquí se VERIFICA ese token (firma con las llaves públicas del equipo, audiencia
 * de la aplicación, emisor y vigencia). Sin esto, cualquiera que llegue por
 * workers.dev o falsifique el encabezado se lo saltaría.
 *
 * Configuración (variables, no secretos):
 *   ACCESS_TEAM_DOMAIN  p. ej. "birevx.cloudflareaccess.com"
 *   ACCESS_AUD          la «Application Audience (AUD) Tag» de la aplicación de Access
 *   PANEL_HOST          p. ej. "panel.birevx.com": /admin por otro host se redirige aquí
 *   ACCESS_ONLY="1"     apaga la contraseña compartida (Basic Auth) cuando ya se probó Access
 * Sin ACCESS_TEAM_DOMAIN/ACCESS_AUD todo sigue igual que antes (Basic Auth).
 */
import type { Env } from "../env";

export interface AccessConfig { teamDomain: string; aud: string }

export function accessConfig(env: Env): AccessConfig | null {
  const team = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!team || !aud || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team)) return null;
  return { teamDomain: team, aud };
}

const b64url = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

type Jwk = JsonWebKey & { kid?: string };
let cache: { team: string; keys: Jwk[]; hasta: number } | null = null;
export function __resetAccessCache() { cache = null; }

async function llaves(team: string, now: number, fetcher: typeof fetch): Promise<Jwk[]> {
  if (cache && cache.team === team && cache.hasta > now) return cache.keys;
  const res = await fetcher(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs_${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cache = { team, keys, hasta: now + 3_600_000 };
  return keys;
}

export type AccessResult = { ok: true; email: string } | { ok: false; motivo: string };

/** Verifica el token de Access. Nunca lanza: devuelve el motivo si no vale. */
export async function verificarAccess(
  token: string | null | undefined,
  cfg: AccessConfig,
  opts: { now?: number; fetcher?: typeof fetch } = {},
): Promise<AccessResult> {
  if (!token) return { ok: false, motivo: "sin_token" };
  const partes = token.split(".");
  if (partes.length !== 3) return { ok: false, motivo: "formato" };
  const now = opts.now ?? Date.now();
  try {
    const head = json(partes[0]);
    const pay = json(partes[1]);
    if (head.alg !== "RS256") return { ok: false, motivo: "algoritmo" };
    const auds: string[] = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
    if (!auds.includes(cfg.aud)) return { ok: false, motivo: "audiencia" };
    if (pay.iss !== `https://${cfg.teamDomain}`) return { ok: false, motivo: "emisor" };
    const segs = Math.floor(now / 1000);
    if (typeof pay.exp !== "number" || pay.exp < segs - 30) return { ok: false, motivo: "vencido" };
    if (typeof pay.nbf === "number" && pay.nbf > segs + 30) return { ok: false, motivo: "aun_no" };
    // OJO: `fetch` suelto (sin ligar) truena en Workers con «Illegal invocation»; por eso se envuelve.
    const keys = await llaves(cfg.teamDomain, now, opts.fetcher ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i)));
    const jwk = keys.find((k) => k.kid === head.kid) ?? (keys.length === 1 ? keys[0] : undefined);
    if (!jwk) return { ok: false, motivo: "llave_desconocida" };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valida = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(partes[2]), new TextEncoder().encode(`${partes[0]}.${partes[1]}`));
    if (!valida) return { ok: false, motivo: "firma" };
    const email = typeof pay.email === "string" ? pay.email : "";
    return email ? { ok: true, email } : { ok: false, motivo: "sin_correo" };
  } catch {
    return { ok: false, motivo: "error_verificando" };
  }
}

/** El token llega en el encabezado; si no, en la cookie que deja Access. */
export function tokenDeAccess(req: Request): string | null {
  const h = req.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("Cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}
