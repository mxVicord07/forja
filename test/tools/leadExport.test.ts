import { describe, it, expect } from "vitest";
import { parseContactInfo } from "../../src/tools/leadExport";

describe("parseContactInfo", () => {
  it("caso real de producción: teléfono y email juntos con '/' — no corrompe el teléfono con dígitos del correo", () => {
    const result = parseContactInfo("4447029227 / manuel_pl3@hotmail.com");
    expect(result.phone).toBe("4447029227");
    expect(result.email).toBe("manuel_pl3@hotmail.com");
  });

  it("alias de Instagram junto a teléfono", () => {
    const result = parseContactInfo("@mi_negocio_ig, tel 5551234567");
    expect(result.phone).toBe("5551234567");
    expect(result.otherContact).toContain("@mi_negocio_ig");
  });

  it("solo email", () => {
    const result = parseContactInfo("cliente@ejemplo.com");
    expect(result).toEqual({ email: "cliente@ejemplo.com" });
  });

  it("solo teléfono", () => {
    const result = parseContactInfo("+52 155 1234 5678");
    expect(result.phone).toBe("5215512345678");
    expect(result.email).toBeUndefined();
  });

  it("string vacío o undefined → objeto vacío", () => {
    expect(parseContactInfo(undefined)).toEqual({});
    expect(parseContactInfo("")).toEqual({});
    expect(parseContactInfo("   ")).toEqual({});
  });

  it("solo alias de red social, sin teléfono ni email", () => {
    const result = parseContactInfo("en instagram soy @tal_negocio");
    expect(result.phone).toBeUndefined();
    expect(result.email).toBeUndefined();
    expect(result.otherContact).toContain("@tal_negocio");
  });
});
