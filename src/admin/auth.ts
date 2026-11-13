/**
 * Admin dashboard authentication — HTTP Basic Auth.
 *
 * The dashboard is guarded by a single password (username is always "admin").
 * The password lives in the `DASHBOARD_PASSWORD` secret. There is no login
 * form, no cookie, no magic link and no email-based flow: the browser's native
 * Basic Auth dialog handles credential entry.
 */
import { basicAuth } from "hono/basic-auth";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { accessConfig, tokenDeAccess, verificarAccess } from "./access";

/** Fixed username for the admin dashboard. */
export const ADMIN_USERNAME = "admin";

/**
 * Hono middleware factory enforcing HTTP Basic Auth on admin routes.
 * Mount it on the `/admin/*` group, e.g. `app.use("/admin/*", adminAuth(env))`.
 */
export function adminAuth(env: Env): MiddlewareHandler {
  // Cloudflare Access (acceso por persona, paso 8): si está configurado, el token
  // firmado de Access basta y la contraseña compartida queda como respaldo hasta
  // ACCESS_ONLY="1". Sin configurar, todo igual que antes (solo Basic Auth).
  const cfg = accessConfig(env);
  const panelHost = (env.PANEL_HOST ?? "").trim().toLowerCase();
  const soloAccess = Boolean(cfg) && env.ACCESS_ONLY === "1";
  // Fail cerrado: el basicAuth de Hono compara contra sha256(String(password)).
  // Si DASHBOARD_PASSWORD es undefined, String(undefined) === "undefined", así
  // que un atacante que mande literalmente "admin:undefined" pasaría el guard.
  // No dejamos que basicAuth llegue a construirse con un password ausente —
  // ese template es MIT y lo instala gente que puede olvidar setear el secret.
  const basic = env.DASHBOARD_PASSWORD
    ? basicAuth({ username: ADMIN_USERNAME, password: env.DASHBOARD_PASSWORD })
    : null;
  return async (c, next) => {
    if (cfg) {
      const url = new URL(c.req.url);
      // El panel solo se sirve en su dominio protegido; por workers.dev se redirige.
      if (panelHost && url.hostname.toLowerCase() !== panelHost) {
        return c.redirect(`https://${panelHost}${url.pathname}${url.search}`, 302);
      }
      const r = await verificarAccess(tokenDeAccess(c.req.raw), cfg);
      if (r.ok) {
        c.header("X-Panel-Usuario", r.email);
        return next();
      }
      if (soloAccess) {
        return c.text(`Entra al panel con tu correo en https://${panelHost || url.hostname}/admin (motivo: ${r.motivo}).`, 403);
      }
    }
    if (!basic) return c.text("Panel admin no configurado: falta DASHBOARD_PASSWORD.", 503);
    return basic(c, next);
  };
}
