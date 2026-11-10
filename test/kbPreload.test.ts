import { describe, expect, it, vi } from "vitest";
import {
  KB_PRELOAD_MIN_SCORE,
  debePrecargar,
  elegirPasajes,
  precargarKb,
  renderKbBlock,
} from "../src/kbPreload";
import type { SearchKbResult } from "../src/tools/searchKb";
import type { Env } from "../src/env";

const env = {} as Env;
const p = (title: string, score: number, content = `Contenido de ${title}`): SearchKbResult => ({ title, content, score });

describe("debePrecargar", () => {
  it("no busca en cortesías ni en mensajes cortos", () => {
    for (const t of ["hola", "Buenos días", "gracias!", "ok", "sí", "perfecto", "a ver", "cuánto cuesta"]) expect(debePrecargar(t)).toBe(false);
  });
  it("busca en preguntas reales", () => {
    expect(debePrecargar("¿Tengo que dejar de usar la app de WhatsApp Business?")).toBe(true);
    expect(debePrecargar("cuanto cuesta el asistente para mi clinica")).toBe(true);
  });
});

describe("elegirPasajes", () => {
  it("descarta los de poco score, ordena, quita repetidos y limita a 3", () => {
    const r = elegirPasajes([p("A", 0.9), p("B", 0.5), p("C", 0.8), p("c", 0.79), p("D", 0.7), p("E", 0.66)]);
    expect(r.map((x) => x.title)).toEqual(["A", "C", "D"]);
    expect(r.every((x) => x.score >= KB_PRELOAD_MIN_SCORE)).toBe(true);
  });
  it("ignora pasajes sin contenido", () => {
    expect(elegirPasajes([{ title: "Vacío", content: "  ", score: 0.95 }])).toEqual([]);
  });
});

describe("renderKbBlock", () => {
  it("pone los pasajes dentro del bloque y no manda citar la base", () => {
    const b = renderKbBlock([p("Coexistencia", 0.9, "Puedes seguir usando la app.")]);
    expect(b.startsWith("<conocimiento>")).toBe(true);
    expect(b.endsWith("</conocimiento>")).toBe(true);
    expect(b).toContain("[Coexistencia]\nPuedes seguir usando la app.");
    expect(b).toMatch(/sin decir «según mi base de conocimiento»/);
  });
  it("recorta pasajes muy largos sin partir palabras", () => {
    const largo = "palabra ".repeat(400);
    const b = renderKbBlock([p("Largo", 0.9, largo)]);
    expect(b.length).toBeLessThan(largo.length);
    expect(b).toContain("…");
  });
});

describe("precargarKb", () => {
  it("devuelve los pasajes que pasan el umbral", async () => {
    const consulta = vi.fn().mockResolvedValue([p("Costos", 0.88), p("Otro", 0.4)]);
    const r = await precargarKb(env, "cuánto cuesta el asistente de WhatsApp", { consulta });
    expect(r.map((x) => x.title)).toEqual(["Costos"]);
    expect(consulta).toHaveBeenCalledOnce();
  });
  it("no consulta con cortesías ni cuando KB_PRELOAD=off", async () => {
    const consulta = vi.fn();
    expect(await precargarKb(env, "hola", { consulta })).toEqual([]);
    expect(await precargarKb({ KB_PRELOAD: "off" } as unknown as Env, "cuánto cuesta el asistente de WhatsApp", { consulta })).toEqual([]);
    expect(consulta).not.toHaveBeenCalled();
  });
  it("es fail-soft: error y tardanza devuelven []", async () => {
    const falla = vi.fn().mockRejectedValue(new Error("vectorize caído"));
    expect(await precargarKb(env, "cuánto cuesta el asistente de WhatsApp", { consulta: falla })).toEqual([]);
    const lenta = vi.fn(() => new Promise<SearchKbResult[]>(() => {}));
    expect(await precargarKb(env, "cuánto cuesta el asistente de WhatsApp", { consulta: lenta, timeoutMs: 20 })).toEqual([]);
  });
});
