import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { DocumentsRepo } from "../../src/db/documents";
import { shareDocumentTool } from "../../src/tools/shareDocument";

let env: any;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = { DB: d1 };
  await new DocumentsRepo(new Db(d1 as any)).upsert({
    id: "web",
    title: "Paquetes de sitios web",
    description: "precios de páginas web, paquetes, cotización",
    filename: "birevx-website-services.pdf",
    r2Key: "documents/web/birevx-website-services.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1000,
  });
});

describe("shareDocumentTool", () => {
  it("encuentra el documento y avisa por el callback onShare", async () => {
    const onShare = vi.fn();
    const tool = shareDocumentTool(env, onShare);
    const result = (await tool.execute!({ query: "paquetes de sitios web" }, {} as any)) as {
      found: boolean;
      title?: string;
    };
    expect(result.found).toBe(true);
    expect(result.title).toBe("Paquetes de sitios web");
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onShare.mock.calls[0][0].id).toBe("web");
  });

  it("found:false y sin callback si no hay match", async () => {
    const onShare = vi.fn();
    const tool = shareDocumentTool(env, onShare);
    const result = (await tool.execute!({ query: "algo que no existe" }, {} as any)) as { found: boolean };
    expect(result.found).toBe(false);
    expect(onShare).not.toHaveBeenCalled();
  });

  it("no lanza si D1 falla — responde found:false", async () => {
    const tool = shareDocumentTool({ DB: null } as any);
    const result = (await tool.execute!({ query: "paquetes" }, {} as any)) as { found: boolean };
    expect(result.found).toBe(false);
  });
});
