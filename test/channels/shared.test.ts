import { describe, it, expect } from "vitest";
import { hmacHex, timingSafeEqual } from "../../src/channels/shared";

describe("hmacHex", () => {
  it("produce un HMAC-SHA256 hex estable", async () => {
    const a = await hmacHex("clave", "mensaje");
    const b = await hmacHex("clave", "mensaje");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cambia si cambia el secret", async () => {
    expect(await hmacHex("k1", "m")).not.toBe(await hmacHex("k2", "m"));
  });
});

describe("timingSafeEqual", () => {
  it("true solo si son idénticos", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("false si difieren en longitud", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
