import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { adminAuth } from "../../src/admin/auth";
import type { Env } from "../../src/env";

describe("adminAuth — fail closed cuando falta DASHBOARD_PASSWORD", () => {
  // Hono's basicAuth compara con sha256(String(password)); si password es
  // undefined, String(undefined) === "undefined" y ese literal SÍ autentica.
  // Este bloque prueba que adminAuth nunca llega a construir ese middleware
  // vulnerable cuando el secret falta — debe responder 503 primero.
  function app(env: Partial<Env>) {
    const a = new Hono<{ Bindings: Env }>();
    a.use("*", (c, next) => adminAuth(c.env)(c, next));
    a.get("/x", (c) => c.text("ok"));
    return { app: a, env: env as Env };
  }

  it("responde 503 sin exponer el dashboard cuando DASHBOARD_PASSWORD falta", async () => {
    const { app: a, env } = app({});
    const res = await a.request("/x", {}, env);
    expect(res.status).toBe(503);
  });

  it("NO autentica con el literal 'admin:undefined' cuando el secret falta", async () => {
    const { app: a, env } = app({});
    const header = `Basic ${Buffer.from("admin:undefined", "utf-8").toString("base64")}`;
    const res = await a.request("/x", { headers: { Authorization: header } }, env);
    expect(res.status).toBe(503);
  });

  it("responde 503 también cuando DASHBOARD_PASSWORD es string vacío", async () => {
    const { app: a, env } = app({ DASHBOARD_PASSWORD: "" });
    const res = await a.request("/x", {}, env);
    expect(res.status).toBe(503);
  });

  it("con el secret presente, sigue exigiendo Basic Auth normalmente", async () => {
    const { app: a, env } = app({ DASHBOARD_PASSWORD: "secret123" });
    const res = await a.request("/x", {}, env);
    expect(res.status).toBe(401);
  });
});
