import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { accessConfig, verificarAccess, tokenDeAccess, __resetAccessCache } from "../../src/admin/access";
import { adminAuth } from "../../src/admin/auth";

const TEAM = "birevx.cloudflareaccess.com";
const AUD = "aud-panel-123";
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64(new TextEncoder().encode(JSON.stringify(o)));

async function llavesPar() {
  const par = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", par.publicKey)) as JsonWebKey;
  return { par, jwk: { ...jwk, kid: "k1" } };
}
async function firmar(priv: CryptoKey, payload: Record<string, unknown>, kid = "k1") {
  const cuerpo = `${enc({ alg: "RS256", kid })}.${enc(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(cuerpo));
  return `${cuerpo}.${b64(sig)}`;
}
const ahora = Date.parse("2026-11-13T18:00:00Z");
const seg = Math.floor(ahora / 1000);
const pay = (o: Record<string, unknown> = {}) => ({ aud: [AUD], iss: `https://${TEAM}`, exp: seg + 3600, iat: seg, email: "victor@birevx.com", ...o });

let k: Awaited<ReturnType<typeof llavesPar>>;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  __resetAccessCache();
  k ??= await llavesPar();
  fetcher = vi.fn(async () => new Response(JSON.stringify({ keys: [k.jwk] }), { status: 200 }));
});
afterEach(() => vi.unstubAllGlobals());
const cfg = { teamDomain: TEAM, aud: AUD };

describe("verificarAccess", () => {
  it("acepta un token bien firmado y devuelve el correo", async () => {
    const t = await firmar(k.par.privateKey, pay());
    expect(await verificarAccess(t, cfg, { now: ahora, fetcher: fetcher as any })).toEqual({ ok: true, email: "victor@birevx.com" });
  });
  it("rechaza otra audiencia, otro emisor, vencido, firma de otra llave y basura", async () => {
    const o = { now: ahora, fetcher: fetcher as any };
    expect((await verificarAccess(await firmar(k.par.privateKey, pay({ aud: ["otra"] })), cfg, o)).ok).toBe(false);
    expect((await verificarAccess(await firmar(k.par.privateKey, pay({ iss: "https://otro.cloudflareaccess.com" })), cfg, o)).ok).toBe(false);
    expect(await verificarAccess(await firmar(k.par.privateKey, pay({ exp: seg - 600 })), cfg, o)).toEqual({ ok: false, motivo: "vencido" });
    const ajena = await llavesPar();
    expect(await verificarAccess(await firmar(ajena.par.privateKey, pay()), cfg, o)).toEqual({ ok: false, motivo: "firma" });
    expect(await verificarAccess("a.b", cfg, o)).toEqual({ ok: false, motivo: "formato" });
    expect(await verificarAccess(null, cfg, o)).toEqual({ ok: false, motivo: "sin_token" });
  });
  it("guarda las llaves una hora (no pide certs en cada petición)", async () => {
    const t = await firmar(k.par.privateKey, pay());
    await verificarAccess(t, cfg, { now: ahora, fetcher: fetcher as any });
    await verificarAccess(t, cfg, { now: ahora + 60_000, fetcher: fetcher as any });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("accessConfig y tokenDeAccess", () => {
  it("solo se activa con un dominio de equipo válido y la audiencia", () => {
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as any)).toEqual(cfg);
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: "https://birevx.cloudflareaccess.com/", ACCESS_AUD: AUD } as any)).toEqual(cfg);
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: "evil.com", ACCESS_AUD: AUD } as any)).toBeNull();
    expect(accessConfig({ ACCESS_AUD: AUD } as any)).toBeNull();
  });
  it("lee el encabezado o la cookie de Access", () => {
    expect(tokenDeAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": "t1" } }))).toBe("t1");
    expect(tokenDeAccess(new Request("https://x", { headers: { Cookie: "a=1; CF_Authorization=t2" } }))).toBe("t2");
  });
});

describe("adminAuth con Access", () => {
  const app = (env: Record<string, string>) => {
    const h = new Hono<{ Bindings: any }>();
    h.use("*", (c, next) => adminAuth(c.env)(c, next));
    h.get("/admin/leads", (c) => c.text("ok"));
    return (req: Request) => h.fetch(req, env);
  };
  const base = { DASHBOARD_PASSWORD: "secreta", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, PANEL_HOST: "panel.birevx.com" };
  const basic = "Basic " + btoa("admin:secreta");

  it("sin configurar Access, igual que antes: Basic Auth", async () => {
    const f = app({ DASHBOARD_PASSWORD: "secreta" });
    expect((await f(new Request("https://bot.workers.dev/admin/leads"))).status).toBe(401);
    expect((await f(new Request("https://bot.workers.dev/admin/leads", { headers: { Authorization: basic } }))).status).toBe(200);
  });

  it("por workers.dev redirige al dominio del panel", async () => {
    const r = await app(base)(new Request("https://bot.workers.dev/admin/leads?ia=x"));
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("https://panel.birevx.com/admin/leads?ia=x");
  });

  it("con token válido entra sin contraseña y marca al usuario", async () => {
    vi.stubGlobal("fetch", fetcher);
    const t = await firmar(k.par.privateKey, pay({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    const r = await app(base)(new Request("https://panel.birevx.com/admin/leads", { headers: { "Cf-Access-Jwt-Assertion": t } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Panel-Usuario")).toBe("victor@birevx.com");
  });

  it("en transición la contraseña sigue sirviendo; con ACCESS_ONLY ya no", async () => {
    vi.stubGlobal("fetch", fetcher);
    const req = () => new Request("https://panel.birevx.com/admin/leads", { headers: { Authorization: basic } });
    expect((await app(base)(req())).status).toBe(200);
    const r = await app({ ...base, ACCESS_ONLY: "1" })(req());
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("https://panel.birevx.com/admin");
  });
});
