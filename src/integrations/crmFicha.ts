/**
 * Ficha del cliente en el CRM (Odoo de BIRevX), de SOLO LECTURA, servida por
 * el workflow de n8n `BRX_Forja_Ficha_Cliente`. Diseño v3 (30-oct-2026) en
 * Arquitectura Digital BIRevX/SEGUIMIENTO_Forja_Odoo.md: Forja lee una ficha
 * curada (etapa, propuesta, últimas interacciones), nunca escribe en Odoo y
 * nunca ve el chatter ni notas internas.
 *
 * Fail-soft siempre, igual que leadExport.ts: sin URL, sin cliente o con n8n
 * caído, devuelve null y el bot responde como antes.
 */
import type { Env } from "../env";

export interface CrmFicha {
  lead: {
    id: number;
    titulo: string;
    tipo: "oportunidad" | "lead";
    etapa_clave: string | null;
    etapa: string | null;
    monto: number;
    etiquetas: string[];
    empresa: string | null;
    contacto: string | null;
    /** Contacto de la empresa cuyo teléfono coincide con quien escribe (puede ser distinto del principal). Opcional: fichas anteriores al 3-nov-2026 no lo traen. */
    contacto_que_escribe?: string | null;
    resumen_ultima_interaccion: string | null;
    ultimo_contacto: string | null;
    proxima_actividad: { fecha: string | null; resumen: string | null } | null;
    /** Indicaciones que Victor escribe para el bot en la oportunidad (`x_brief_lia`). Opcional: fichas anteriores al 1-nov-2026 no lo traen. */
    brief?: string | null;
  };
  cotizacion: {
    folio: string;
    estado: string;
    monto_sin_iva: number;
    vigencia: string | null;
    /** Detalle de la propuesta vigente (I-023). Opcional: la ficha anterior al 3-nov-2026 solo trae lo de arriba. */
    referencia?: string | null;
    monto_total?: number;
    anticipo_pct?: number;
    firmada?: boolean;
    /** Hay un pago de anticipo recibido (transacción hecha o factura pagada). Opcional: fichas anteriores no lo traen. */
    anticipo_pagado?: boolean;
    firmada_el?: string | null;
    firmada_por?: string | null;
    lineas?: { descripcion: string; subtotal: number }[];
    tiene_pdf?: boolean;
    /** Enlace del portal de Odoo (con su token): el que el cliente usa para ver y firmar. Solo existe si ya se generó. */
    enlace?: string | null;
  } | null;
  /** Semáforo de contacto de Odoo (BRX_Copiloto_Semaforo, 7:00): `codigo` es accion:razon y no cambia; `texto` es para leer. */
  semaforo?: { codigo: string; texto: string | null; siguiente_toque: string | null } | null;
  interacciones: {
    fecha: string | null;
    canal: string | null;
    direccion: string | null;
    resumen: string | null;
    documentos: string | null;
  }[];
}

/** Tiempo máximo de espera: la ficha nunca debe retrasar la respuesta. */
const TIMEOUT_MS = 2500;

/**
 * Etapas en las que Victor lleva la relación y el bot no negocia. La ficha ya trae la clave técnica, pero Odoo nombra las
 * etapas en español y Victor las renombra (Pre-Calificados, Propuesta, Ganado): se aceptan también esos nombres, para que
 * un renombrado no apague el candado en silencio.
 */
const ETAPAS_DE_VICTOR = new Set([
  "Qualified", "Proposition", "Won",
  "Calificado", "Pre-Calificados", "Propuesta", "Ganado",
]);

/** true si la oportunidad está en una etapa cuya relación lleva Victor en persona. */
export function llevaVictor(f: CrmFicha): boolean {
  return !!f.lead.etapa_clave && ETAPAS_DE_VICTOR.has(f.lead.etapa_clave);
}

/**
 * true si el semáforo de contacto de Odoo dice que a esta persona no se le escribe: ganada, pidió no ser contactada o está
 * en pausa. Un "esperar: contacto reciente" NO cuenta: de 0 a 48 h el toque es de Forja (diseño en SEGUIMIENTO_Forja_Odoo.md).
 */
export function noTocar(f: CrmFicha): boolean {
  const c = f.semaforo?.codigo ?? "";
  return c.startsWith("no_tocar:") || c === "esperar:pausa";
}

export async function fetchCrmFicha(
  env: Env,
  who: { conversationId: string; channel: string; channelUserId: string },
): Promise<CrmFicha | null> {
  if (!env.CRM_FICHA_URL) return null;
  try {
    const res = await fetch(env.CRM_FICHA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: who.conversationId,
        channel: who.channel,
        // En WhatsApp el id del canal ES el teléfono; en otros canales no.
        ...(who.channel === "whatsapp" ? { phone: who.channelUserId } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json()) as Partial<CrmFicha> & { ok?: boolean; encontrado?: boolean };
    if (!data?.ok || !data.encontrado || !data.lead) return null;
    return { lead: data.lead, cotizacion: data.cotizacion ?? null, semaforo: data.semaforo ?? null, interacciones: data.interacciones ?? [] };
  } catch (err) {
    console.warn("[crmFicha] no se pudo leer la ficha:", err);
    return null;
  }
}

/** Pesos exactos: con centavos cuando los hay ($23.20, $21,912.40) y sin ellos cuando es entero ($60,500). */
const pesos = (n: number) =>
  Number.isInteger(n)
    ? `$${n.toLocaleString("en-US")} MXN`
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;

/**
 * Bloque de sistema con la ficha. Da continuidad (no volver a preguntar lo
 * que ya se sabe, no contradecir la propuesta) sin convertir datos internos
 * en algo que el bot le diga al cliente: la próxima actividad, las etiquetas
 * y el monto estimado de la oportunidad se quedan fuera a propósito.
 */
export function renderCrmBlock(f: CrmFicha): string {
  const l = f.lead;
  const lineas: string[] = [];
  const quien = [l.contacto, l.empresa ? `(${l.empresa})` : null].filter(Boolean).join(" ");
  if (quien) lineas.push(`- Cliente: ${quien}`);
  if (l.contacto_que_escribe && l.contacto_que_escribe !== l.contacto) {
    lineas.push(`- Quien te escribe ahora es ${l.contacto_que_escribe}, otro contacto de la misma empresa: háblale por su nombre; la propuesta y el proyecto son los mismos`);
  }
  lineas.push(`- Proyecto en conversación: ${l.titulo}`);
  if (l.etapa) lineas.push(`- Etapa: ${l.etapa}`);
  if (f.cotizacion) {
    const c = f.cotizacion;
    lineas.push(
      c.estado === "enviada" || c.estado === "confirmada"
        ? `- Propuesta ${c.estado}: ${c.folio}${c.referencia ? ` (${c.referencia})` : ""} por ${pesos(c.monto_sin_iva)} + IVA${c.vigencia ? `, vigente hasta ${c.vigencia}` : ""}`
        : `- Hay una propuesta en preparación que todavía no se le ha enviado: no menciones montos ni la des por enviada`,
    );
    if (c.estado === "enviada" || c.estado === "confirmada") {
      if (c.monto_total != null && c.anticipo_pct != null) {
        lineas.push(`- Total con IVA ${pesos(c.monto_total)}; anticipo de ${c.anticipo_pct}% = ${pesos((c.monto_total * c.anticipo_pct) / 100)}`);
      }
      if (c.lineas?.length) {
        lineas.push(`- La propuesta incluye: ${c.lineas.map((x) => `${x.descripcion} (${x.subtotal < 0 ? "-" : ""}${pesos(Math.abs(x.subtotal))})`).join("; ")}`);
      }
      if (c.firmada && c.anticipo_pagado) {
        lineas.push(
          `- El cliente ya aceptó, firmó${c.firmada_el ? ` el ${c.firmada_el}` : ""} y pagó el anticipo: no se la vuelvas a ofrecer ni le pidas pagar otra vez; lo que sigue es el arranque del proyecto, que coordina Victor. Para fechas, facturas o cualquier cambio avisa a Victor`,
        );
      } else if (c.firmada) {
        lineas.push(
          `- El cliente ya aceptó y firmó esta propuesta${c.firmada_el ? ` el ${c.firmada_el}` : ""}: no se la vuelvas a ofrecer; lo que sigue es el anticipo, y para ese enlace o cualquier cambio avisa a Victor`,
        );
      } else if (c.estado === "enviada" && c.enlace) {
        lineas.push(
          `- Enlace de la propuesta: ${c.enlace} (es el de este cliente; si pide verla de nuevo o quiere aceptarla, es este, nunca otro enlace ni uno inventado)`,
        );
      }
    }
  }
  if (l.resumen_ultima_interaccion) {
    lineas.push(`- Última conversación${l.ultimo_contacto ? ` (${l.ultimo_contacto})` : ""}: ${l.resumen_ultima_interaccion}`);
  }
  if (l.brief?.trim()) lineas.push(`- Indicaciones de Victor para atender a este cliente: ${l.brief.trim()}`);
  for (const i of f.interacciones) {
    if (i.resumen) lineas.push(`- ${i.fecha ?? "Sin fecha"}, ${i.canal ?? "contacto"}: ${i.resumen}`);
  }

  const reglas = [
    "Úsalo para dar continuidad: no vuelvas a preguntar lo que ya se sabe y no contradigas la propuesta.",
    "Nunca menciones que tienes este registro, ni etapas, etiquetas o notas internas.",
  ];
  if (llevaVictor(f)) {
    reglas.push(
      "Victor atiende personalmente a este cliente. Si pide descuento, cambio de precio, de alcance o de condiciones, o quiere cerrar o firmar, no negocies ni cambies la propuesta: dile que Victor lo revisa personalmente y le responde, y usa la herramienta handoffHuman. Solo puedes mencionar otro servicio del negocio si existe en tu base de conocimiento, a su precio de lista y aclarando que Victor lo arma; no inventes paquetes recortados.",
    );
  }

  return `<crm>\nRegistro interno de este cliente en el CRM de BIRevX.\n${lineas.join("\n")}\n${reglas.join("\n")}\n</crm>`;
}
