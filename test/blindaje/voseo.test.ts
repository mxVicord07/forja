import { describe, it, expect } from "vitest";
import { FRASES_VOSEO } from "../../src/blindaje/voseo";

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

  it("no toca el español de México", () => {
    expect(hay("sin molestar a quien ya está contigo")).toBe(false);
    expect(hay("¿Qué tienes que hacer?")).toBe(false);
    expect(hay("Si quieres, puedes mandarlo")).toBe(false);
    expect(hay("Déjame explicarte, mira qué sencillo")).toBe(false);
    expect(hay("Con tu ticket de $400 estás en el rango")).toBe(false);
    expect(hay("El servicio sostiene la operación")).toBe(false);
  });
});
