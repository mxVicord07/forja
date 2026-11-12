import { describe, it, expect } from "vitest";
import { parseDia, sumarDias, claveDia, rangoCalendario, agruparPorDia, navegarCalendario } from "../../src/agenda/calendario";
import type { CitaPanel } from "../../src/agenda/source";

const TZ = "America/Mexico_City";

describe("parseDia", () => {
  it("acepta fechas reales y rechaza el resto", () => {
    expect(parseDia("2026-11-12")).toEqual({ y: 2026, m: 11, d: 12 });
    expect(parseDia("2026-02-30")).toBeNull();
    expect(parseDia("12/11/2026")).toBeNull();
    expect(parseDia(undefined)).toBeNull();
    expect(parseDia("2026-11-12<script>")).toBeNull();
  });
});

describe("sumarDias / claveDia", () => {
  it("cruza meses y años", () => {
    expect(claveDia(sumarDias({ y: 2026, m: 12, d: 30 }, 3))).toBe("2027-01-02");
    expect(claveDia(sumarDias({ y: 2026, m: 3, d: 1 }, -1))).toBe("2026-02-28");
  });
});

describe("rangoCalendario", () => {
  it("semana: de lunes a domingo con el rango en UTC de la zona", () => {
    const r = rangoCalendario("semana", { y: 2026, m: 11, d: 12 }, TZ); // jueves
    expect(r.celdas.map((c) => c.clave)).toEqual([
      "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
    ]);
    expect(r.desde).toBe("2026-11-09T06:00:00.000Z");
    expect(r.hasta).toBe("2026-11-16T06:00:00.000Z");
  });

  it("semana: si la referencia es domingo, la semana termina ese día", () => {
    const r = rangoCalendario("semana", { y: 2026, m: 11, d: 15 }, TZ);
    expect(r.celdas[0].clave).toBe("2026-11-09");
    expect(r.celdas[6].clave).toBe("2026-11-15");
  });

  it("mes: noviembre de 2026 ocupa 6 filas de lunes a domingo", () => {
    const r = rangoCalendario("mes", { y: 2026, m: 11, d: 12 }, TZ);
    expect(r.celdas).toHaveLength(42);
    expect(r.celdas[0].clave).toBe("2026-10-26");
    expect(r.celdas[41].clave).toBe("2026-12-06");
    expect(r.celdas.filter((c) => c.delMes)).toHaveLength(30);
    expect(r.desde).toBe("2026-10-26T06:00:00.000Z");
    expect(r.hasta).toBe("2026-12-07T06:00:00.000Z");
    expect(r.titulo).toBe("noviembre de 2026");
  });

  it("mes: febrero de 2027 cabe en 4 filas (empieza en lunes y tiene 28 días)", () => {
    const r = rangoCalendario("mes", { y: 2027, m: 2, d: 10 }, TZ);
    expect(r.celdas).toHaveLength(28);
    expect(r.celdas[0].clave).toBe("2027-02-01");
  });
});

describe("navegarCalendario", () => {
  it("semana: ±7 días", () => {
    expect(navegarCalendario("semana", { y: 2026, m: 11, d: 12 }, -1)).toBe("2026-11-05");
    expect(navegarCalendario("semana", { y: 2026, m: 11, d: 12 }, 1)).toBe("2026-11-19");
  });
  it("mes: primer día del mes anterior o siguiente, también al cruzar el año", () => {
    expect(navegarCalendario("mes", { y: 2026, m: 11, d: 12 }, 1)).toBe("2026-12-01");
    expect(navegarCalendario("mes", { y: 2026, m: 12, d: 31 }, 1)).toBe("2027-01-01");
    expect(navegarCalendario("mes", { y: 2027, m: 1, d: 5 }, -1)).toBe("2026-12-01");
  });
});

describe("agruparPorDia", () => {
  const cita = (uid: string, inicio: string): CitaPanel => ({
    uid, titulo: "", inicio, duracionMin: 50, estado: "confirmada", origen: "reserva",
    persona: { nombre: uid, correo: "", telefono: null }, lugar: null, enlace: null, conversacion: null,
  });
  it("agrupa por día local, no por día UTC", () => {
    // 2026-11-17T03:30Z es el 16 a las 21:30 en Ciudad de México
    const g = agruparPorDia([cita("a", "2026-11-17T03:30:00Z"), cita("b", "2026-11-17T16:00:00Z")], TZ);
    expect(g.get("2026-11-16")!.map((c) => c.uid)).toEqual(["a"]);
    expect(g.get("2026-11-17")!.map((c) => c.uid)).toEqual(["b"]);
  });
});
