import { describe, it, expect } from "vitest";
import {
  SUPERPOWERS,
  readSuperpowers,
  superpowerIsOn,
  superpowerValue,
  findSuperpower,
  SETTING_VALIDATORS,
  bool01,
} from "../src/settings-mutations";
import { SETTING_KEYS } from "../src/db/settings";

describe("SUPERPOWERS — payments (skill /cobros)", () => {
  it("está en el array, Pro, default OFF, encoding bool01", () => {
    const def = findSuperpower("payments");
    expect(def).toMatchObject({
      key: SETTING_KEYS.paymentsEnabled,
      encoding: "bool01",
      defaultOn: false,
      pro: true,
    });
  });

  it("readSuperpowers: ausente = apagado (opt-in real, no como salesHunter/blindaje)", () => {
    const out = readSuperpowers({});
    expect(out.payments).toBe(false);
  });

  it('readSuperpowers: "1" = prendido, "0" = apagado', () => {
    expect(readSuperpowers({ [SETTING_KEYS.paymentsEnabled]: "1" }).payments).toBe(true);
    expect(readSuperpowers({ [SETTING_KEYS.paymentsEnabled]: "0" }).payments).toBe(false);
  });

  it("superpowerIsOn / superpowerValue son inversos entre sí", () => {
    const def = findSuperpower("payments")!;
    expect(superpowerIsOn(def, superpowerValue(def, true))).toBe(true);
    expect(superpowerIsOn(def, superpowerValue(def, false))).toBe(false);
  });

  it("tiene el validador bool01 en SETTING_VALIDATORS", () => {
    expect(SETTING_VALIDATORS[SETTING_KEYS.paymentsEnabled]).toBe(bool01);
  });
});

describe("SUPERPOWERS — cobertura completa (no se rompe con el nuevo miembro)", () => {
  it("son 7 superpoderes, todos Pro", () => {
    expect(SUPERPOWERS).toHaveLength(7);
    expect(SUPERPOWERS.every((s) => s.pro)).toBe(true);
  });

  it("readSuperpowers siempre devuelve las 7 llaves, sin extras", () => {
    const out = readSuperpowers({});
    expect(Object.keys(out).sort()).toEqual(
      ["salesHunter", "blindaje", "dailyReport", "satisfactionSurvey", "reengage", "reviews", "payments"].sort(),
    );
  });
});
