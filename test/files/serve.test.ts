import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { DocumentsRepo } from "../../src/db/documents";
import { signedFileUrl } from "../../src/files/share";
import { serveDocument } from "../../src/files/serve";

let baseEnv: any;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  await new DocumentsRepo(new Db(d1 as any)).upsert({
    id: "web",
    title: "Paquetes de sitios web",
    description: "precios",
    filename: "birevx-website-services.pdf",
    r2Key: "documents/web/birevx-website-services.pdf",
    mimeType: "application/pdf",
    sizeBytes: 999,
  });
  baseEnv = {
    DB: d1,
    FILES_SIGNING_SECRET: "sekret",
    DASHBOARD_BASE_URL: "https://bot.example.workers.dev",
  };
});

function fakeR2(body: string | null) {
  return {
    get: vi.fn(async (key: string) =>
      body === null ? null : { body: new Response(body).body },
    ),
  };
}

describe("serveDocument", () => {
  it("sirve el objeto de R2 con content-type y content-disposition correctos", async () => {
    const env = { ...baseEnv, CATALOG: fakeR2("%PDF-1.4 contenido falso") };
    const url = await signedFileUrl("web", env, "");
    const u = new URL(url!);
    const res = await serveDocument("web", u.searchParams.get("exp"), u.searchParams.get("sig"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("birevx-website-services.pdf");
    expect(env.CATALOG.get).toHaveBeenCalledWith("documents/web/birevx-website-services.pdf");
  });

  it("403 con firma inválida — nunca toca D1 ni R2 antes de validar", async () => {
    const env = { ...baseEnv, CATALOG: fakeR2("x") };
    const res = await serveDocument("web", String(Date.now() + 1000), "firma-mala", env);
    expect(res.status).toBe(403);
    expect(env.CATALOG.get).not.toHaveBeenCalled();
  });

  it("404 si el id no existe en D1 (firma válida, doc borrado)", async () => {
    const env = { ...baseEnv, CATALOG: fakeR2("x") };
    const url = await signedFileUrl("no-existe", env, "");
    const u = new URL(url!);
    const res = await serveDocument("no-existe", u.searchParams.get("exp"), u.searchParams.get("sig"), env);
    expect(res.status).toBe(404);
  });

  it("404 si D1 tiene la fila pero el objeto ya no está en R2", async () => {
    const env = { ...baseEnv, CATALOG: fakeR2(null) };
    const url = await signedFileUrl("web", env, "");
    const u = new URL(url!);
    const res = await serveDocument("web", u.searchParams.get("exp"), u.searchParams.get("sig"), env);
    expect(res.status).toBe(404);
  });
});
