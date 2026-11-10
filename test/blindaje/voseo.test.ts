import { describe, it, expect } from "vitest";
import { FRASES_VOSEO, corregirVoseoSinAcento } from "../../src/blindaje/voseo";

const hay = (t: string) => FRASES_VOSEO.some((f) => new RegExp(f, "i").test(t));

describe("voseo: el bot habla en español de México", () => {
  it("atrapa el voseo", () => {
    expect(hay("sin molestar a quien ya está con vos")).toBe(true);
    expect(hay("¿Qué tenés que hacer?")).toBe(true);
    expect(hay("si querés, podés mandarlo")).toBe(true);
    expect(hay("Decime cuántas citas pierdes")).toBe(true);
    expect(hay("Mirá, es sencillo")).toBe(true);
    expect(hay("vos sabés cuánto vale")).toBe(true);
    expect(hay("Dejame explicarte")).toBe(true);
  });

  it("atrapa el voseo escrito sin acento (caso del 10-nov: «pensas enviar»)", () => {
    expect(hay("¿Cuántos mensajes pensas enviar al mes?")).toBe(true);
    expect(hay("si queres, podes mandarlo")).toBe(true);
    expect(hay("¿Tenes WhatsApp Business?")).toBe(true);
    expect(hay("¿Venis seguido? ¿Decis que sí?")).toBe(true);
  });

  it("no toca el español de México", () => {
    expect(hay("sin molestar a quien ya está contigo")).toBe(false);
    expect(hay("¿Qué tienes que hacer?")).toBe(false);
    expect(hay("Si quieres, puedes mandarlo")).toBe(false);
    expect(hay("Déjame explicarte, mira qué sencillo")).toBe(false);
    expect(hay("Con tu ticket de $400 estás en el rango")).toBe(false);
    expect(hay("El servicio sostiene la operación")).toBe(false);
    expect(hay("¿Cuántos mensajes piensas enviar? Si quieres, puedes mandarlo; tienes opciones y vienes seguido")).toBe(false);
  });
});

describe("corregirVoseoSinAcento", () => {
  it("lo pasa a tuteo conservando la mayúscula", () => {
    expect(corregirVoseoSinAcento("¿Cuántos mensajes pensas enviar? Si queres, podes avisarme.")).toBe("¿Cuántos mensajes piensas enviar? Si quieres, puedes avisarme.");
    expect(corregirVoseoSinAcento("Tenes razón. Venis seguido y decis que sí.")).toBe("Tienes razón. Vienes seguido y dices que sí.");
  });
  it("no toca el español de México ni palabras que contienen esas letras", () => {
    const ok = "¿Cuántos mensajes piensas enviar? Tienes opciones y puedes elegir; los tenemos todos.";
    expect(corregirVoseoSinAcento(ok)).toBe(ok);
    expect(corregirVoseoSinAcento("Los precios y las tenencias")).toBe("Los precios y las tenencias");
  });
});
