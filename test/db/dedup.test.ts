import { describe, it, expect } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { seenBefore } from "../../src/db/dedup";

describe("seenBefore (candado de duplicados, de Forja+)", () => {
  it("la primera vez deja pasar, la segunda marca duplicado; ids vacíos nunca bloquean", async () => {
    const mf = await createTestMiniflare();
    const db = new Db(await mf.getD1Database("DB"));
    expect(await seenBefore(db, "yc:abc")).toBe(false);
    expect(await seenBefore(db, "yc:abc")).toBe(true);
    expect(await seenBefore(db, "yc:otro")).toBe(false);
    expect(await seenBefore(db, "")).toBe(false);
    expect(await seenBefore(db, "")).toBe(false);
  });
});
