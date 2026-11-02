/**
 * Relevo del dueño al bot (BIRevX I-023, fase R1; diseño en Arquitectura
 * Digital BIRevX/docs/DISENO_Relevo_LIA_y_Aceptacion_de_Propuestas_2026-11-01.md).
 *
 * El dueño retoma a un cliente desde la app de WhatsApp Business (coexistencia)
 * con un mensaje largo y lo cierra con una frase natural ("te dejo con Lía").
 * Esa frase suelta la conversación en vez de pausarla una hora, y mientras el
 * relevo esté vigente el bot atiende en "modo escucha": lee lo que escribió el
 * dueño, pregunta antes de proponer y no negocia la propuesta enviada.
 */

/** Documento de la KB con las formas de arrancar con menos inversión: el bloque manda buscarlo y el blindaje lo trae como fuente. */
export const RELEVO_CONSULTA_KB = "Opciones para arrancar con menos inversión";

/** Frases que Lía nunca dice en relevo (regex): prometen un retorno que nadie puede garantizar. */
export const RELEVO_FRASES_VETADAS = ["se paga(r[aá]|ria|ría)? sol[oa]", "\\bROI\\b"];

/** Frases por defecto, ya normalizadas (sin acentos, minúsculas). */
export const FRASES_RELEVO_DEFAULT = [
  "te dejo con lia",
  "lia te ayuda",
  "lia te atiende",
  "lia sigue contigo",
  "lia te acompana",
  "lia te va a ayudar",
  "te dejo en manos de lia",
  "te dejo con mi asistente",
];

/** La frase cierra el mensaje: solo se busca en este tramo final (texto normalizado). */
const COLA_RELEVO = 200;

/**
 * Minutos después de la frase en los que otro mensaje del dueño (el PDF, un
 * saludo) no vuelve a pausar: suele mandar varias burbujas seguidas.
 */
export const RELEVO_RAFAGA_MS = 5 * 60 * 1000;

/** Tope de mensajes del cliente pendientes de una pausa. */
export const BACKLOG_TOPE = 20;

/** Cuánto dura el modo relevo después de la frase del dueño. */
export const RELEVO_VIGENCIA_MS = 14 * 24 * 60 * 60 * 1000;

/** Lo que el cliente escribió en la pausa solo se contesta si es más reciente que esto. */
export const BACKLOG_MAX_MS = 12 * 60 * 60 * 1000;

/** Tope del mensaje del dueño que se cita en el bloque (el resto ya está en el historial). */
const CITA_MAX = 1500;

function normaliza(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * true si el mensaje del dueño CIERRA con una frase de relevo (en sus últimos
 * 200 caracteres) y no está negada ("no te dejo con Lía"). `frasesEnv`
 * (RELEVO_FRASES, separadas por comas) reemplaza la lista por defecto.
 */
export function esRelevo(texto: string | undefined, frasesEnv?: string): boolean {
  if (!texto) return false;
  const propias = (frasesEnv ?? "").split(",").map(normaliza).filter(Boolean);
  const frases = propias.length ? propias : FRASES_RELEVO_DEFAULT;
  const t = ` ${normaliza(texto).slice(-COLA_RELEVO)} `;
  return frases.some((f) => {
    for (let i = t.indexOf(` ${f} `); i >= 0; i = t.indexOf(` ${f} `, i + 1)) {
      if (!/(^| )no$/.test(t.slice(0, i).trimEnd())) return true;
    }
    return false;
  });
}

/**
 * El modo relevo aplica si el dueño soltó la conversación hace menos de 14 días
 * o si el cliente ya tiene una propuesta enviada: en ambos casos hay una
 * relación en curso que el bot no debe tratar como prospecto nuevo.
 */
export function relevoActivo(
  state: { relevoAt?: number },
  ficha: { cotizacion?: { estado?: string } | null } | null,
  now: number = Date.now(),
): boolean {
  if (state.relevoAt && now - state.relevoAt <= RELEVO_VIGENCIA_MS) return true;
  return ficha?.cotizacion?.estado === "enviada";
}

/**
 * Bloque de sistema del modo escucha. `ultimoDelDueno` es su último mensaje en
 * el historial, si lo hay; `porRelevo` dice si lo activó la frase del dueño (o
 * solo que el cliente ya tiene una propuesta enviada).
 */
export function renderRelevoBlock(ultimoDelDueno: string | null, opts: { porRelevo?: boolean } = {}): string {
  const porRelevo = opts.porRelevo ?? true;
  const lineas = [
    porRelevo
      ? "El dueño ya atendió a este cliente en persona y la conversación sigue contigo."
      : "Este cliente ya tiene una propuesta enviada por el dueño: la relación está en curso y no es un prospecto nuevo.",
  ];
  if (ultimoDelDueno?.trim()) {
    lineas.push(
      "Los mensajes del dueño aparecen en el historial como si fueran tuyos: los escribió él. Si todavía no te presentaste, preséntate por tu nombre como su asistente; nunca digas que tú escribiste lo que él escribió.",
    );
  }
  lineas.push(
    "Lee lo que dijo el dueño y lo que dice el registro del cliente antes de contestar. No vuelvas a preguntar lo que ya se sabe.",
    "Escucha antes de proponer. Haz una sola pregunta por mensaje.",
    "Si viene al caso, averigua con tacto: si la propuesta resolvió lo que necesitaba, si hoy tiene otra prioridad, si el monto o el momento le pesan, y qué parte le daría resultado más rápido.",
    "Si el cliente dice que es mucho o que le pesa el monto, no inventes cifras ni alcances y no repitas los montos de la propuesta si no te los pide: haz una sola pregunta, sin cifras y sin insinuar planes más ligeros: qué le pesa más (lo de arranque o la mensualidad); y dile que el dueño revisa cómo empezar.",
    "No supongas cuántas citas o clientes pierde: si no lo sabe, propón medirlo unas semanas y usa la tabla de «Cómo valorar la inversión con tus números» para decirle cuántas citas extra necesitaría según su ticket. Nunca digas que algo «se paga solo» ni prometas un retorno.",
    `Si le pesa el arranque, busca con searchKb «${RELEVO_CONSULTA_KB}» y menciona el pago en 3 o 6 pagos tal como está escrito, diciendo que el dueño arma el plan. Si le pesa la mensualidad, pregunta su ticket promedio y cuántas citas o clientes pierde, y devuelve la cuenta con sus números, sin prometer un retorno. No calcules planes ni plazos que no estén escritos: si pide otro, usa handoffHuman.`,
    "Solo menciona otros servicios que existan en tu base de conocimiento, a su precio de lista y diciendo que el dueño los arma. No inventes paquetes recortados ni versiones \"básicas\" de lo que no está en tu información. No cambies la propuesta enviada.",
    "Si pide descuento, cambio de alcance o de condiciones, o quiere cerrar o firmar, no negocies: dile que el dueño lo revisa hoy y usa handoffHuman.",
    "Los montos de la propuesta salen del registro del cliente (son sin IVA). Si en el historial aparece otra cifra, no la confirmes: dile que el dueño te la confirma.",
  );
  if (ultimoDelDueno?.trim()) {
    const cita = ultimoDelDueno.trim().slice(0, CITA_MAX);
    lineas.push(`Lo último que escribió el dueño a este cliente: «${cita}»`);
  }
  return `<relevo>\n${lineas.join("\n")}\n</relevo>`;
}
