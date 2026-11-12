import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { DocumentsRepo } from "../../src/db/documents";
import { listarMaterial } from "../../src/material/api";

let env: any;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const repo = new DocumentsRepo(new Db(d1 as any));
  await repo.upsert({
    id: "web",
    title: "Paquetes de sitios web BIRevX",
    description: "precios de paginas web",
    filename: "birevx-website-services.pdf",
    r2Key: "documents/web/birevx-website-services.pdf",
    mimeType: "application/pdf",
    sizeBytes: 549316,
  });
  await repo.upsert({
    id: "dental",
    title: "BIRevX para clínicas dentales",
    description: "clinica dental",
    filename: "BRX_Clinicas-Dentales-Chat_ES.jpg",
    r2Key: "documents/dental/BRX_Clinicas-Dentales-Chat_ES.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 273537,
  });
  env = {
    DB: d1,
    MATERIAL_TOKEN: "token-material-de-prueba",
    FILES_SIGNING_SECRET: "sekret",
    DASHBOARD_BASE_URL: "https://bot.example.workers.dev",
  };
});

describe("listarMaterial", () => {
  it("401 sin token, con token equivocado o con token vacío", async () => {
    for (const provided of ["", "otro", "token-material-de-prueba-x"]) {
      const res = await listarMaterial(provided, env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    }
  });

  it("401 (misma respuesta) si el Worker no tiene MATERIAL_TOKEN configurado", async () => {
    const res = await listarMaterial("lo-que-sea", { ...env, MATERIAL_TOKEN: undefined });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("con token correcto devuelve las piezas con título, tipo y enlace firmado", async () => {
    const res = await listarMaterial("token-material-de-prueba", env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.documents).toHaveLength(2);
    const dental = body.documents.find((d: any) => d.id === "dental");
    expect(dental.title).toBe("BIRevX para clínicas dentales");
    expect(dental.kind).toBe("imagen");
    expect(dental.mime_type).toBe("image/jpeg");
    expect(dental.size_kb).toBe(267);
    expect(dental.url).toMatch(/^https:\/\/bot\.example\.workers\.dev\/files\/dental\?exp=\d+&sig=[0-9a-f]+$/);
    const web = body.documents.find((d: any) => d.id === "web");
    expect(web.kind).toBe("pdf");
  });

  it("no expone la ruta interna de R2 ni el nombre del archivo interno", async () => {
    const res = await listarMaterial("token-material-de-prueba", env);
    const texto = JSON.stringify(await res.json());
    expect(texto).not.toContain("documents/web/");
    expect(texto).not.toContain("r2_key");
    expect(texto).not.toContain("r2Key");
  });

  it("500 claro si hay token pero falta el secreto de firma y la base (no devuelve enlaces rotos)", async () => {
    const sinFirma = { ...env, FILES_SIGNING_SECRET: undefined, KB_REINDEX_TOKEN: undefined };
    const res = await listarMaterial("token-material-de-prueba", sinFirma);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "signing_unavailable" });
  });

  it("lista vacía si no hay documentos (no es error)", async () => {
    const mf = await createTestMiniflare();
    const vacio = await mf.getD1Database("DB");
    const res = await listarMaterial("token-material-de-prueba", { ...env, DB: vacio });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).documents).toEqual([]);
  });
});
