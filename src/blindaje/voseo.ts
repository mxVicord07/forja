/**
 * Voseo: el bot de BIRevX habla en español de México ("tú"). El modelo a veces mezcla voseo rioplatense ("con vos",
 * "tenés", "podés"); el prompt lo pide evitar, pero no basta. Estas expresiones regulares lo rechazan antes de enviar
 * (el verificador de lenguaje lo deja pasar) y el reintento guiado lo reescribe.
 */
const letra = "a-záéíóúñ";
const solo = (formas: string) => `(?<![${letra}])(?:${formas})(?![${letra}])`;

export const FRASES_VOSEO = [
  solo("vos|sos"),
  // formas verbales con acento obligatorio: sin él son español neutro (tienes, sabes, mira)
  solo("tenés|querés|podés|sabés|pensás|venís|decís|hacés|podés|estás vos"),
  solo("mirá|escuchá|pensá|andá|tené|decí|vení|hacé|fijate"),
  // con pronombre pegado: "dejame", "decime"… no existen sin acento en español de México
  solo("dejame|decime|contame|avisame|mandame|pasame"),
];
