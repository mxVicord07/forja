/**
 * GET /admin/boveda (tab Bóveda) y GET /admin/media/:id (servir bytes desde
 * R2, mismo Basic Auth que el resto del panel — nunca una URL pública).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { captureIncomingMedia, ensureMediaTable, __resetMediaEnsured } from "../../src/media/boveda";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";

function basicAuthHeader(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const b64 = typeof btoa === "function" ? btoa(raw) : Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${b64}`;
}

const AUTH = { Authorization: basicAuthHeader("admin", PASSWORD) };

let env: Env;
let d1: any;
let r2: any;
let db: Db;

beforeEach(async () => {
  __resetMediaEnsured();
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  r2 = await mf.getR2Bucket("MEDIA");
  db = new Db(d1);
  env = {
    DB: d1,
    MEDIA: r2,
    DASHBOARD_PASSWORD: PASSWORD,
    BOT_TIER: "pro",
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Test Biz",
    BOT_LANGUAGE: "es",
  } as unknown as Env;
});

describe("GET /admin/boveda", () => {
  it("401 sin Basic Auth", async () => {
    const res = await adminApp.request("/boveda", {}, env);
    expect(res.status).toBe(401);
  });

  it("200 con estado vacío cuando no hay nada archivado", async () => {
    const res = await adminApp.request("/boveda", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Bóveda");
    expect(html).toContain("Aún no hay nada archivado");
  });

  it("avisa cuando no hay bucket MEDIA conectado", async () => {
    const res = await adminApp.request("/boveda", { headers: AUTH }, { ...env, MEDIA: undefined } as any);
    const html = await res.text();
    expect(html).toContain("/boveda</code>");
  });

  it("lista un archivo capturado con su thumbnail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })) as any;
    let id: string | null;
    try {
      id = await captureIncomingMedia(env, db, {
        conversationId: "c1",
        url: "https://example.com/foto.jpg",
        caption: "una cotización",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(id).not.toBeNull();

    const res = await adminApp.request("/boveda", { headers: AUTH }, env);
    const html = await res.text();
    expect(html).toContain(`/admin/media/${id}`);
    expect(html).toContain("una cotización");
    expect(html).not.toContain("Aún no hay nada archivado");
  });
});

describe("GET /admin/media/:id", () => {
  async function seedImage(): Promise<string> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "image/jpeg" } })) as any;
    try {
      const id = await captureIncomingMedia(env, db, { conversationId: "c1", url: "https://example.com/x.jpg" });
      if (!id) throw new Error("seed failed");
      return id;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("401 sin Basic Auth", async () => {
    const id = await seedImage();
    const res = await adminApp.request(`/media/${id}`, {}, env);
    expect(res.status).toBe(401);
  });

  it("sirve los bytes con el content-type correcto", async () => {
    const id = await seedImage();
    const res = await adminApp.request(`/media/${id}`, { headers: AUTH }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([9, 9, 9]);
  });

  it("404 si el id no existe", async () => {
    const res = await adminApp.request("/media/no-existe", { headers: AUTH }, env);
    expect(res.status).toBe(404);
  });

  it("nunca sirve un archivo direction='out' por esta ruta (es de la app, no del panel)", async () => {
    await ensureMediaTable(db);
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO media (id, conversation_id, r2_key, kind, mime, bytes, created_at, direction)
       VALUES (?, 'c1', 'media/out/x.jpg', 'image', 'image/jpeg', 3, ?, 'out')`,
      [id, Date.now()],
    );
    await r2.put("media/out/x.jpg", new Uint8Array([1]));
    const res = await adminApp.request(`/media/${id}`, { headers: AUTH }, env);
    expect(res.status).toBe(404);
  });

  it("410 si la fila existe pero el objeto ya no está en R2", async () => {
    await ensureMediaTable(db);
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO media (id, conversation_id, r2_key, kind, mime, bytes, created_at, direction)
       VALUES (?, 'c1', 'media/borrado.jpg', 'image', 'image/jpeg', 3, ?, 'in')`,
      [id, Date.now()],
    );
    const res = await adminApp.request(`/media/${id}`, { headers: AUTH }, env);
    expect(res.status).toBe(410);
  });
});
