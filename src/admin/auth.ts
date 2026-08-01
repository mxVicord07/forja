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

/** Fixed username for the admin dashboard. */
export const ADMIN_USERNAME = "admin";

/**
 * Hono middleware factory enforcing HTTP Basic Auth on admin routes.
 * Mount it on the `/admin/*` group, e.g. `app.use("/admin/*", adminAuth(env))`.
 */
export function adminAuth(env: Env): MiddlewareHandler {
  // Fail cerrado: el basicAuth de Hono compara contra sha256(String(password)).
  // Si DASHBOARD_PASSWORD es undefined, String(undefined) === "undefined", así
  // que un atacante que mande literalmente "admin:undefined" pasaría el guard.
  // No dejamos que basicAuth llegue a construirse con un password ausente —
  // ese template es MIT y lo instala gente que puede olvidar setear el secret.
  if (!env.DASHBOARD_PASSWORD) {
    return async (c) =>
      c.text("Panel admin no configurado: falta DASHBOARD_PASSWORD.", 503);
  }
  return basicAuth({
    username: ADMIN_USERNAME,
    password: env.DASHBOARD_PASSWORD,
  });
}

