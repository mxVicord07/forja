import { describe, it, expect } from "vitest";
import { verifyYCloudSignature } from "../../src/channels/ycloud";
import { hmacHex } from "../../src/channels/shared";

const SECRET = "whsec_test";

async function signed(raw: string, tSeconds: number): Promise<string> {
  const s = await hmacHex(SECRET, `${tSeconds}.${raw}`);
  return `t=${tSeconds},s=${s}`;
}

describe("verifyYCloudSignature", () => {
  const raw = JSON.stringify({ hello: "world" });
  const now = 1_800_000_000_000; // ms
  const t = Math.floor(now / 1000);

  it("acepta una firma válida y fresca", async () => {
    expect(await verifyYCloudSignature(raw, await signed(raw, t), SECRET, now)).toBe(true);
  });

  it("rechaza si el cuerpo fue alterado", async () => {
    const header = await signed(raw, t);
    expect(await verifyYCloudSignature(raw + "x", header, SECRET, now)).toBe(false);
  });

  it("rechaza una firma vieja (fuera de la ventana anti-replay)", async () => {
    const old = t - 301; // 5 min + 1 s
    expect(await verifyYCloudSignature(raw, await signed(raw, old), SECRET, now)).toBe(false);
  });

  it("rechaza un timestamp del futuro fuera de ventana", async () => {
    const future = t + 301;
    expect(await verifyYCloudSignature(raw, await signed(raw, future), SECRET, now)).toBe(false);
  });

  it("rechaza un header malformado", async () => {
    for (const h of ["", "basura", "t=abc,s=def", `t=${t}`, `s=abc`]) {
      expect(await verifyYCloudSignature(raw, h, SECRET, now)).toBe(false);
    }
  });

  it("rechaza si falta el header o el secret (fail-closed)", async () => {
    expect(await verifyYCloudSignature(raw, null, SECRET, now)).toBe(false);
    expect(await verifyYCloudSignature(raw, await signed(raw, t), "", now)).toBe(false);
  });
});
