import { describe, it, expect, vi } from "vitest";
import { signedFileUrl, verifyFileUrl } from "../../src/files/share";

const env = { FILES_SIGNING_SECRET: "sekret", DASHBOARD_BASE_URL: "https://bot.example.workers.dev" } as any;

describe("signedFileUrl / verifyFileUrl", () => {
  it("una URL recién firmada verifica válida", async () => {
    const url = await signedFileUrl("doc-1", env, "");
    expect(url).toMatch(/^https:\/\/bot\.example\.workers\.dev\/files\/doc-1\?exp=\d+&sig=[0-9a-f]+$/);
    const u = new URL(url!);
    const ok = await verifyFileUrl("doc-1", u.searchParams.get("exp"), u.searchParams.get("sig"), env);
    expect(ok).toBe(true);
  });

  it("rechaza sig de otro documento (no se puede reusar entre ids)", async () => {
    const url = await signedFileUrl("doc-1", env, "");
    const u = new URL(url!);
    const ok = await verifyFileUrl("doc-2", u.searchParams.get("exp"), u.searchParams.get("sig"), env);
    expect(ok).toBe(false);
  });

  it("rechaza una URL vencida", async () => {
    vi.useFakeTimers();
    const url = await signedFileUrl("doc-1", env, "");
    const u = new URL(url!);
    vi.advanceTimersByTime(31 * 60 * 1000); // TTL es 30 min
    const ok = await verifyFileUrl("doc-1", u.searchParams.get("exp"), u.searchParams.get("sig"), env);
    expect(ok).toBe(false);
    vi.useRealTimers();
  });

  it("cae a KB_REINDEX_TOKEN si no hay FILES_SIGNING_SECRET propio", async () => {
    const fallbackEnv = { KB_REINDEX_TOKEN: "reindex-tok", DASHBOARD_BASE_URL: "https://bot.example.workers.dev" } as any;
    const url = await signedFileUrl("doc-1", fallbackEnv, "");
    const u = new URL(url!);
    expect(await verifyFileUrl("doc-1", u.searchParams.get("exp"), u.searchParams.get("sig"), fallbackEnv)).toBe(true);
    // Y NO valida contra un secreto distinto (confirma que sí está usando el fallback, no un secreto vacío).
    expect(await verifyFileUrl("doc-1", u.searchParams.get("exp"), u.searchParams.get("sig"), { ...fallbackEnv, KB_REINDEX_TOKEN: "otro" })).toBe(false);
  });

  it("null si falta secreto o base", async () => {
    expect(await signedFileUrl("doc-1", {} as any, "")).toBeNull();
    expect(await signedFileUrl("doc-1", { FILES_SIGNING_SECRET: "s" } as any, "")).toBeNull();
  });

  it("verifyFileUrl es fail-closed ante params ausentes/malformados", async () => {
    expect(await verifyFileUrl("doc-1", null, null, env)).toBe(false);
    expect(await verifyFileUrl("doc-1", "abc", "sig", env)).toBe(false);
    expect(await verifyFileUrl("doc-1", String(Date.now() + 1000), "basura", env)).toBe(false);
  });
});
