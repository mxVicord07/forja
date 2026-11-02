import { describe, it, expect } from "vitest";
import { esRelevo, relevoActivo, renderRelevoBlock, RELEVO_VIGENCIA_MS } from "../src/relevo";

describe("esRelevo — el dueño le pasa la conversación al bot con una frase natural", () => {
  it("reconoce la frase con acento, mayúsculas y texto alrededor", () => {
    expect(esRelevo("Gracias por tu tiempo, Hugo. Te dejo con Lía, mi asistente, para lo que necesites.")).toBe(true);
    expect(esRelevo("LÍA TE AYUDA con lo que haga falta")).toBe(true);
    expect(esRelevo("cualquier duda, lia sigue contigo")).toBe(true);
    expect(esRelevo("te   dejo con   lia")).toBe(true);
  });

  it("no se dispara con frases parecidas que no son relevo", () => {
    expect(esRelevo("te dejo el enlace de la propuesta")).toBe(false);
    expect(esRelevo("¿quién es Lía?")).toBe(false);
    expect(esRelevo("")).toBe(false);
    expect(esRelevo(undefined)).toBe(false);
  });

  it("reconoce variantes comunes", () => {
    expect(esRelevo("Cualquier cosa, Lía te va a ayudar.")).toBe(true);
    expect(esRelevo("Te dejo en manos de Lía.")).toBe(true);
  });

  it("no se dispara con una negación ni a media conversación", () => {
    expect(esRelevo("No, no te dejo con Lía: yo te atiendo personalmente.")).toBe(false);
    expect(esRelevo("Lía te ayuda a agendar después, pero antes cuéntame: ¿cuántos empleados tienen hoy en la clínica y quién lleva la agenda? " + "Me interesa entender bien cómo trabajan para ajustar la propuesta. ".repeat(4) + "¿Te parece?")).toBe(false);
  });

  it("RELEVO_FRASES reemplaza la lista por defecto (separada por comas)", () => {
    expect(esRelevo("te paso con Ana, ella te atiende", "te paso con ana, ana te atiende")).toBe(true);
    expect(esRelevo("te dejo con Lía", "te paso con ana")).toBe(false);
  });

  it("una RELEVO_FRASES vacía o con solo espacios usa la lista por defecto", () => {
    expect(esRelevo("te dejo con Lía", "  ")).toBe(true);
  });
});

describe("relevoActivo", () => {
  const ahora = Date.UTC(2026, 10, 1, 12);

  it("activo si hubo relevo en los últimos 14 días", () => {
    expect(relevoActivo({ relevoAt: ahora - 2 * 86400000 }, null, ahora)).toBe(true);
    expect(relevoActivo({ relevoAt: ahora - RELEVO_VIGENCIA_MS - 1 }, null, ahora)).toBe(false);
  });

  it("activo si la ficha trae una propuesta enviada, aunque no haya relevo", () => {
    expect(relevoActivo({}, { cotizacion: { estado: "enviada" } }, ahora)).toBe(true);
    expect(relevoActivo({}, { cotizacion: { estado: "borrador (aún no enviada)" } }, ahora)).toBe(false);
    expect(relevoActivo({}, { cotizacion: null }, ahora)).toBe(false);
    expect(relevoActivo({}, null, ahora)).toBe(false);
  });
});

describe("renderRelevoBlock", () => {
  it("trae las reglas del modo escucha y el candado de la propuesta", () => {
    const b = renderRelevoBlock(null);
    expect(b.startsWith("<relevo>")).toBe(true);
    expect(b.endsWith("</relevo>")).toBe(true);
    expect(b).toMatch(/una sola pregunta/i);
    expect(b).toMatch(/precio de lista/i);
    expect(b).toMatch(/handoffHuman/);
    expect(b).not.toMatch(/Lo último que escribió el dueño/);
  });

  it("ante 'es mucho para arrancar' pregunta qué pesa más y no inventa paquetes ni cifras", () => {
    const b = renderRelevoBlock(null);
    expect(b).toMatch(/qué le pesa más/i);
    expect(b).toMatch(/no inventes/i);
    expect(b).toMatch(/base de conocimiento/i);
    expect(b).not.toMatch(/alternativa más ligera/i);
  });

  it("no repite montos si el cliente no los pidió", () => {
    expect(renderRelevoBlock(null)).toMatch(/no repitas (los )?montos/i);
  });

  it("si solo hay propuesta enviada (sin relevo), no afirma que el dueño acaba de atender", () => {
    const b = renderRelevoBlock(null, { porRelevo: false });
    expect(b).not.toMatch(/ya atendió a este cliente en persona/);
    expect(b).toMatch(/propuesta enviada/i);
  });

  it("cita el último mensaje del dueño, recortado", () => {
    const largo = "a".repeat(3000);
    const b = renderRelevoBlock(`Hola Hugo, ${largo}`);
    expect(b).toMatch(/Lo último que escribió el dueño/);
    expect(b).toContain("Hola Hugo, ");
    expect(b.length).toBeLessThan(4200);
  });
});
