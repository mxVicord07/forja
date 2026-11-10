import { describe, expect, it } from "vitest";
import { diaLocal, hoyParaPrompt, normalizarRecordatorio, RECORDATORIO_MAX_DIAS } from "../../src/insights/recordatorio";

// 9-nov-2026, 22:30 en Ciudad de México (UTC-6) = 10-nov 04:30 UTC: el día local sigue siendo el 9.
const AHORA = Date.parse("2026-11-10T04:30:00Z");

describe("hoyParaPrompt y diaLocal", () => {
  it("usan el día de Ciudad de México, no el UTC", () => {
    expect(diaLocal(AHORA)).toBe("2026-11-09");
    expect(hoyParaPrompt(AHORA)).toBe("lunes 2026-11-09");
  });
});

describe("normalizarRecordatorio", () => {
  it("acepta una fecha futura y limpia el motivo", () => {
    expect(normalizarRecordatorio({ date: "2026-11-15", reason: "  escribirle   para retomar la propuesta " }, AHORA)).toEqual({ fecha: "2026-11-15", motivo: "escribirle para retomar la propuesta" });
  });
  it("acepta hoy y el último día permitido", () => {
    expect(normalizarRecordatorio({ date: "2026-11-09", reason: "x" }, AHORA)?.fecha).toBe("2026-11-09");
    const limite = new Date(Date.parse("2026-11-09T00:00:00Z") + RECORDATORIO_MAX_DIAS * 86_400_000).toISOString().slice(0, 10);
    expect(normalizarRecordatorio({ date: limite, reason: "x" }, AHORA)?.fecha).toBe(limite);
  });
  it("sin motivo deja uno genérico", () => {
    expect(normalizarRecordatorio({ date: "2026-11-20", reason: "" }, AHORA)?.motivo).toBe("retomar la conversación");
  });
  it("descarta lo dudoso: pasado, demasiado lejos, formato malo, fecha imposible, no objeto", () => {
    expect(normalizarRecordatorio({ date: "2026-11-08", reason: "x" }, AHORA)).toBeNull();
    expect(normalizarRecordatorio({ date: "2027-12-01", reason: "x" }, AHORA)).toBeNull();
    expect(normalizarRecordatorio({ date: "15 de noviembre", reason: "x" }, AHORA)).toBeNull();
    expect(normalizarRecordatorio({ date: "2026-02-31", reason: "x" }, AHORA)).toBeNull();
    expect(normalizarRecordatorio({ reason: "x" }, AHORA)).toBeNull();
    expect(normalizarRecordatorio(null, AHORA)).toBeNull();
    expect(normalizarRecordatorio("2026-11-15", AHORA)).toBeNull();
  });
  it("recorta un motivo larguísimo", () => {
    expect(normalizarRecordatorio({ date: "2026-11-20", reason: "a".repeat(500) }, AHORA)?.motivo.length).toBe(200);
  });
});
