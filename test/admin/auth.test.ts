import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { checkBasicCredentials, ADMIN_USERNAME, adminAuth } from "../../src/admin/auth";
import type { Env } from "../../src/env";

const env = { DASHBOARD_PASSWORD: "secret123" } as unknown as Env;

/** base64("admin:secret123") === "YWRtaW46c2VjcmV0MTIz" */
const validHeader = "Basic YWRtaW46c2VjcmV0MTIz";

describe("checkBasicCredentials", () => {
  it("accepts the correct admin:secret123 header", () => {
    expect(checkBasicCredentials(validHeader, env)).toBe(true);
  });

  it("is case-insensitive on the Basic scheme keyword", () => {
    expect(checkBasicCredentials("basic YWRtaW46c2VjcmV0MTIz", env)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const header = `Basic ${btoa(`${ADMIN_USERNAME}:wrongpass`)}`;
    expect(checkBasicCredentials(header, env)).toBe(false);
  });

  it("rejects a wrong username", () => {
    const header = `Basic ${btoa("root:secret123")}`;
    expect(checkBasicCredentials(header, env)).toBe(false);
  });

  it("rejects an absent header", () => {
    expect(checkBasicCredentials(undefined, env)).toBe(false);
    expect(checkBasicCredentials(null, env)).toBe(false);
    expect(checkBasicCredentials("", env)).toBe(false);
  });

  it("rejects a malformed header (no Basic scheme)", () => {
    expect(checkBasicCredentials("Bearer YWRtaW46c2VjcmV0MTIz", env)).toBe(false);
    expect(checkBasicCredentials("YWRtaW46c2VjcmV0MTIz", env)).toBe(false);
  });

  it("rejects a payload that decodes without a colon separator", () => {
    const header = `Basic ${btoa("adminsecret123")}`;
    expect(checkBasicCredentials(header, env)).toBe(false);
  });

  it("uses the FIRST colon so passwords containing colons still work", () => {
    const colonEnv = { DASHBOARD_PASSWORD: "a:b:c" } as unknown as Env;
    const header = `Basic ${btoa("admin:a:b:c")}`;
    expect(checkBasicCredentials(header, colonEnv)).toBe(true);
  });
});

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
