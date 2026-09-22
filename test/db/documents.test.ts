import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { DocumentsRepo, matchDocument, type DocumentRow } from "../../src/db/documents";

let repo: DocumentsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  repo = new DocumentsRepo(new Db(d1 as any));
});

describe("DocumentsRepo", () => {
  it("upsert + getById + list", async () => {
    await repo.upsert({
      id: "doc-1",
      title: "Paquetes de sitios web",
      description: "precios de páginas web, paquetes, cotización",
      filename: "birevx-website-services.pdf",
      r2Key: "documents/doc-1/birevx-website-services.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12345,
    });
    const doc = await repo.getById("doc-1");
    expect(doc?.title).toBe("Paquetes de sitios web");
    expect(doc?.r2_key).toBe("documents/doc-1/birevx-website-services.pdf");
    const list = await repo.list();
    expect(list).toHaveLength(1);
  });

  it("upsert es idempotente por id (actualiza, no duplica)", async () => {
    await repo.upsert({
      id: "doc-1",
      title: "v1",
      description: "d1",
      filename: "a.pdf",
      r2Key: "documents/doc-1/a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
    });
    await repo.upsert({
      id: "doc-1",
      title: "v2",
      description: "d2",
      filename: "a.pdf",
      r2Key: "documents/doc-1/a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2,
    });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("v2");
  });

  it("delete lo quita", async () => {
    await repo.upsert({
      id: "doc-1",
      title: "t",
      description: "d",
      filename: "a.pdf",
      r2Key: "documents/doc-1/a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
    });
    await repo.delete("doc-1");
    expect(await repo.getById("doc-1")).toBeNull();
  });
});

function doc(over: Partial<DocumentRow>): DocumentRow {
  return {
    id: "d",
    title: "",
    description: "",
    filename: "a.pdf",
    r2_key: "documents/d/a.pdf",
    mime_type: "application/pdf",
    size_bytes: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

describe("matchDocument", () => {
  const docs = [
    doc({ id: "web", title: "Paquetes de sitios web", description: "precios de páginas web, paquetes, cotización" }),
    doc({ id: "hosting", title: "Planes de hosting", description: "renovación anual, dominios" }),
  ];

  it("empareja por frase completa contenida en título/descripción", () => {
    expect(matchDocument("paquetes de sitios web", docs)?.id).toBe("web");
  });

  it("empareja por una sola palabra significativa", () => {
    expect(matchDocument("cotización", docs)?.id).toBe("web");
  });

  it("no empareja con query vacío o sin ninguna palabra en común", () => {
    expect(matchDocument("", docs)).toBeNull();
    expect(matchDocument("xyzabc123", docs)).toBeNull();
  });

  it("ignora palabras de 2 letras o menos al buscar por palabra suelta", () => {
    // "un" no es substring de ningún doc y es demasiado corto para el filtro
    // de palabras (> 2 caracteres) — no debe emparejar nada.
    expect(matchDocument("un", docs)).toBeNull();
  });

  // Hallazgo real (21-sep-2026): un documento cargado sin tildes en la
  // descripción no emparejaba con un cliente que sí acentúa bien.
  it("ignora acentos — el documento SIN tilde empareja con una query CON tilde", () => {
    const sinTilde = [
      doc({ id: "sistemas", title: "Sistemas Comerciales BIRevX", description: "cotizacion de sistema comercial, automatizacion" }),
    ];
    expect(matchDocument("cotización", sinTilde)?.id).toBe("sistemas");
    expect(matchDocument("automatización", sinTilde)?.id).toBe("sistemas");
  });

  it("ignora acentos — la query SIN tilde empareja con un documento CON tilde", () => {
    expect(matchDocument("cotizacion", docs)?.id).toBe("web");
  });

  it("ignora la diéresis de la ñ igual que el resto de acentos (mismo criterio que fold() de resolveDate)", () => {
    const conEnie = [doc({ id: "d", title: "t", description: "diseño de campaña" })];
    expect(matchDocument("diseno", conEnie)?.id).toBe("d");
  });
});
