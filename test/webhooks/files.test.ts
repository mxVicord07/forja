import { describe, it, expect } from "vitest";

// Mismo mock que whatsapp-dispatch.test.ts: `agents` no carga fuera de workerd.
import { vi } from "vitest";
vi.mock("agents", () => ({ Agent: class {} }));

import worker from "../../src/index";
import { signedFileUrl } from "../../src/files/share";

function fakeR2(body: string | null) {
  return { get: async () => (body === null ? null : { body: new Response(body).body }) };
}

function envWith(catalog: ReturnType<typeof fakeR2>, extra: any = {}) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: "web",
            title: "Paquetes de sitios web",
            description: "precios",
            filename: "birevx-website-services.pdf",
            r2_key: "documents/web/birevx-website-services.pdf",
            mime_type: "application/pdf",
            size_bytes: 999,
            created_at: 0,
            updated_at: 0,
          }),
        }),
      }),
    },
    CATALOG: catalog,
    FILES_SIGNING_SECRET: "sekret",
    DASHBOARD_BASE_URL: "https://bot.test",
    ...extra,
  } as any;
}

describe("GET /files/:id", () => {
  it("200 + PDF con firma válida", async () => {
    const env = envWith(fakeR2("%PDF-1.4"));
    const url = await signedFileUrl("web", env, "");
    const res = await worker.fetch(new Request(url!), env, {} as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("403 sin firma", async () => {
    const env = envWith(fakeR2("%PDF-1.4"));
    const res = await worker.fetch(new Request("https://bot.test/files/web"), env, {} as any);
    expect(res.status).toBe(403);
  });

  it("403 con firma de otro id", async () => {
    const env = envWith(fakeR2("%PDF-1.4"));
    const url = await signedFileUrl("otro-doc", env, "");
    const u = new URL(url!);
    u.pathname = "/files/web"; // reusa exp+sig de "otro-doc" contra el id "web"
    const res = await worker.fetch(new Request(u.toString()), env, {} as any);
    expect(res.status).toBe(403);
  });
});
