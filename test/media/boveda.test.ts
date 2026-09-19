/**
 * Bóveda (superpoder opt-in, skill /boveda): archiva en R2 lo que el cliente
 * manda. D1 + R2 reales vía miniflare — captureIncomingMedia es fail-open
 * (nunca lanza), así que se verifica el resultado, no excepciones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import {
  captureIncomingMedia,
  attachMediaToMessage,
  getMediaRow,
  ensureMediaTable,
  kindForMime,
  extForMime,
  __resetMediaEnsured,
  MEDIA_MAX_BYTES,
} from "../../src/media/boveda";
import type { Env } from "../../src/env";

let d1: any;
let r2: any;
let db: Db;
let env: Env;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  r2 = await mf.getR2Bucket("MEDIA");
  db = new Db(d1);
  __resetMediaEnsured();
  env = { DB: d1, MEDIA: r2 } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kindForMime / extForMime", () => {
  it("clasifica por prefijo de mime", () => {
    expect(kindForMime("image/jpeg")).toBe("image");
    expect(kindForMime("audio/ogg")).toBe("audio");
    expect(kindForMime("application/pdf")).toBe("document");
  });

  it("da la extensión conocida o bin si no la reconoce", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("audio/ogg")).toBe("ogg");
    expect(extForMime("application/x-nadie-sabe-que-es-esto")).toBe("bin");
  });
});

describe("captureIncomingMedia", () => {
  it("sin binding MEDIA: no hace nada (null, sin tocar fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const id = await captureIncomingMedia({ DB: d1 } as unknown as Env, db, {
      conversationId: "c1",
      url: "https://example.com/foto.jpg",
    });
    expect(id).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("descarga, sube a R2 y guarda la fila — happy path de imagen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/jpeg" } }),
    );
    const id = await captureIncomingMedia(env, db, {
      conversationId: "c1",
      url: "https://example.com/foto.jpg",
      caption: "mira esto",
    });
    expect(id).not.toBeNull();

    const row = await getMediaRow(db, id!);
    expect(row).not.toBeNull();
    expect(row!.conversation_id).toBe("c1");
    expect(row!.kind).toBe("image");
    expect(row!.mime).toBe("image/jpeg");
    expect(row!.caption).toBe("mira esto");
    expect(row!.bytes).toBe(4);
    expect(row!.direction).toBe("in");
    expect(row!.r2_key).toContain("c1");

    const obj = await r2.get(row!.r2_key);
    expect(obj).not.toBeNull();
  });

  it("respeta el kind explícito aunque el content-type diga otra cosa", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { "content-type": "application/octet-stream" } }),
    );
    const id = await captureIncomingMedia(env, db, {
      conversationId: "c1",
      url: "https://example.com/audio",
      kind: "audio",
    });
    const row = await getMediaRow(db, id!);
    expect(row!.kind).toBe("audio");
  });

  it("descarta un archivo vacío", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([])));
    const id = await captureIncomingMedia(env, db, { conversationId: "c1", url: "https://x/y" });
    expect(id).toBeNull();
  });

  it("descarta un archivo más grande que MEDIA_MAX_BYTES", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(MEDIA_MAX_BYTES + 1)),
    );
    const id = await captureIncomingMedia(env, db, { conversationId: "c1", url: "https://x/y" });
    expect(id).toBeNull();
  });

  it("no archiva una página de error HTML/JSON disfrazada de media", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>error</html>", { headers: { "content-type": "text/html" } }),
    );
    const id = await captureIncomingMedia(env, db, { conversationId: "c1", url: "https://x/y" });
    expect(id).toBeNull();
  });

  it("fail-open: un fetch que lanza no revienta el turno, solo devuelve null", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await expect(
      captureIncomingMedia(env, db, { conversationId: "c1", url: "https://x/y" }),
    ).resolves.toBeNull();
  });

  it("fail-open: un fetch que responde !ok devuelve null sin lanzar", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    const id = await captureIncomingMedia(env, db, { conversationId: "c1", url: "https://x/y" });
    expect(id).toBeNull();
  });
});

describe("attachMediaToMessage", () => {
  it("liga filas de media existentes al message_id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } }),
    );
    const id = await captureIncomingMedia(env, db, { conversationId: "c1", url: "https://x/y" });
    await attachMediaToMessage(db, [id!], "msg-1");
    const row = await getMediaRow(db, id!);
    expect(row!.message_id).toBe("msg-1");
  });

  it("sin ids no hace ninguna query", async () => {
    const runSpy = vi.spyOn(db, "run");
    await attachMediaToMessage(db, [], "msg-1");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("nunca lanza aunque la tabla no exista (best-effort)", async () => {
    const brokenDb = new Db({ prepare: () => { throw new Error("boom"); } } as any);
    await expect(attachMediaToMessage(brokenDb, ["x"], "msg-1")).resolves.toBeUndefined();
  });
});

describe("getMediaRow", () => {
  it("null si no existe", async () => {
    expect(await getMediaRow(db, "no-existe")).toBeNull();
  });

  it("null (no lanza) si la tabla aún no se creó", async () => {
    const brokenDb = new Db({ prepare: () => { throw new Error("boom"); } } as any);
    expect(await getMediaRow(brokenDb, "x")).toBeNull();
  });
});

describe("ensureMediaTable", () => {
  it("es idempotente (memoizada por isolate, no falla en la segunda llamada)", async () => {
    await ensureMediaTable(db);
    await expect(ensureMediaTable(db)).resolves.toBeUndefined();
  });
});
