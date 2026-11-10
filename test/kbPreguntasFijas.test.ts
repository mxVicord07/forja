import { describe, expect, it } from "vitest";
import fixture from "./fixtures/lia-preguntas-fijas.json";

// Las 10 preguntas fijas de I-018: aquí solo se cuida que el conjunto siga bien formado.
// Se prueban contra Lía a mano (o con el evaluador en vivo) antes y después de cada cambio.
describe("preguntas fijas de prospecto (I-018)", () => {
  it("son 10, con id único, pregunta y hechos", () => {
    expect(fixture.preguntas).toHaveLength(10);
    expect(new Set(fixture.preguntas.map((p) => p.id)).size).toBe(10);
    for (const p of fixture.preguntas) {
      expect(p.pregunta.length).toBeGreaterThan(10);
      expect(p.debe_decir.length).toBeGreaterThan(0);
      expect(p.nunca_digas.length).toBeGreaterThan(0);
    }
  });
  it("las frases prohibidas generales cubren la maquinaria interna y el voseo", () => {
    const g = fixture.ademas_en_cada_respuesta.nunca_digas.join(" ");
    expect(g).toMatch(/base de conocimiento/);
    expect(g).toMatch(/tenés/);
  });
});
