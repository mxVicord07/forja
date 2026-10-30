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
    resumen_ultima_interaccion: string | null;
    ultimo_contacto: string | null;
    proxima_actividad: { fecha: string | null; resumen: string | null } | null;
  };
  cotizacion: { folio: string; estado: string; monto_sin_iva: number; vigencia: string | null } | null;
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

/** Etapas en las que Victor lleva la relación y el bot no negocia. */
const ETAPAS_DE_VICTOR = new Set(["Qualified", "Proposition", "Won"]);

/** true si la oportunidad está en una etapa cuya relación lleva Victor en persona. */
export function llevaVictor(f: CrmFicha): boolean {
  return !!f.lead.etapa_clave && ETAPAS_DE_VICTOR.has(f.lead.etapa_clave);
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
    return { lead: data.lead, cotizacion: data.cotizacion ?? null, interacciones: data.interacciones ?? [] };
  } catch (err) {
    console.warn("[crmFicha] no se pudo leer la ficha:", err);
    return null;
  }
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString("en-US")} MXN`;

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
  lineas.push(`- Proyecto en conversación: ${l.titulo}`);
  if (l.etapa) lineas.push(`- Etapa: ${l.etapa}`);
  if (f.cotizacion) {
    const c = f.cotizacion;
    lineas.push(
      c.estado === "enviada" || c.estado === "confirmada"
        ? `- Propuesta ${c.estado}: ${c.folio} por ${pesos(c.monto_sin_iva)} + IVA${c.vigencia ? `, vigente hasta ${c.vigencia}` : ""}`
        : `- Hay una propuesta en preparación que todavía no se le ha enviado: no menciones montos ni la des por enviada`,
    );
  }
  if (l.resumen_ultima_interaccion) {
    lineas.push(`- Última conversación${l.ultimo_contacto ? ` (${l.ultimo_contacto})` : ""}: ${l.resumen_ultima_interaccion}`);
  }
  for (const i of f.interacciones) {
    if (i.resumen) lineas.push(`- ${i.fecha ?? "Sin fecha"}, ${i.canal ?? "contacto"}: ${i.resumen}`);
  }

  const reglas = [
    "Úsalo para dar continuidad: no vuelvas a preguntar lo que ya se sabe y no contradigas la propuesta.",
    "Nunca menciones que tienes este registro, ni etapas, etiquetas o notas internas.",
  ];
  if (llevaVictor(f)) {
    reglas.push(
      "Victor atiende personalmente a este cliente. Si pide descuento, cambio de precio, de alcance o de condiciones, o quiere cerrar o firmar, no negocies ni des cifras nuevas: dile que Victor lo revisa personalmente y le responde, y usa la herramienta handoffHuman.",
    );
  }

  return `<crm>\nRegistro interno de este cliente en el CRM de BIRevX.\n${lineas.join("\n")}\n${reglas.join("\n")}\n</crm>`;
}
