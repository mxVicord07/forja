import type { Env } from "../env";

export interface ParsedContact {
  email?: string;
  phone?: string;
  otherContact?: string;
}

// Dominios de más de una etiqueta (".com.mx", ".correo.uaslp.mx") son
// cotidianos en México — sin el grupo repetido, la regex cortaba el dominio
// en la primera etiqueta y mandaba a Odoo un correo sintácticamente válido
// pero inexistente (misma clase de bug que el de producción del 20-ago).
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]{2,}/;
// Secuencia de dígitos con separadores típicos de teléfono (espacios, guiones,
// paréntesis, +) intercalados — 7 a 15 dígitos tras limpiar no-dígitos.
const PHONE_RE = /(?:\+?\d[\d\s\-().]*){7,20}/;

/**
 * Separa el campo libre "contact" (teléfono y/o email y/o alias de red social,
 * todo en un solo string) en sus partes. Causa raíz del bug real de
 * producción (2026-08-20): "4447029227 / manuel_pl3@hotmail.com" se trataba
 * entero como teléfono, y los dígitos de "pl3" contaminaban el número. Por
 * eso el email se extrae y se remueve del string ANTES de buscar el teléfono.
 */
export function parseContactInfo(raw: string | undefined): ParsedContact {
  if (!raw || !raw.trim()) return {};

  let rest = raw;
  const result: ParsedContact = {};

  const emailMatch = rest.match(EMAIL_RE);
  if (emailMatch) {
    result.email = emailMatch[0];
    rest = rest.slice(0, emailMatch.index) + rest.slice(emailMatch.index! + emailMatch[0].length);
  }

  const phoneMatch = rest.match(PHONE_RE);
  if (phoneMatch) {
    const digits = phoneMatch[0].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      result.phone = digits;
      rest = rest.slice(0, phoneMatch.index) + rest.slice(phoneMatch.index! + phoneMatch[0].length);
    }
  }

  // Solo se captura un alias reconocible (@handle) del texto sobrante, NO
  // el texto libre completo — frases naturales como "mi whats es X y mi
  // correo es Y" dejaban basura tipo "mi whats es mi correo" en otherContact,
  // que viajaba tal cual al chatter del CRM.
  const handleMatch = rest.match(/@[\w.]{2,}/);
  if (handleMatch) {
    result.otherContact = handleMatch[0];
  }

  return result;
}

export interface LeadExportInput {
  leadId: string;
  conversationId: string | null;
  name?: string;
  contact?: string;
  intent: string;
  notes?: string;
  channel: string;
  /** Origen publicitario de la conversación (primer toque), si llegó desde un anuncio. */
  adOrigin?: { ctwaClid: string | null; sourceId: string | null; sourceType: string | null; headline: string | null } | null;
}

export interface LeadExportResult {
  exported: boolean;
  externalId?: string;
}

/**
 * Exporta un lead a Odoo vía el webhook n8n (BIRevX_Forja_Lead_to_Odoo).
 * Fail-soft SIEMPRE: nunca tira excepción hacia el caller — ni por timeout,
 * ni por respuesta inválida, ni si el webhook no está configurado. El caller
 * decide qué hacer con { exported, externalId } (p.ej. leads.setExported).
 * No escribe en D1 — solo parseo + red.
 */
export async function exportLeadToOdoo(env: Env, lead: LeadExportInput): Promise<LeadExportResult> {
  if (!env.LEAD_EXPORT_WEBHOOK_URL) return { exported: false };

  const { email, phone, otherContact } = parseContactInfo(lead.contact);

  try {
    const res = await fetch(env.LEAD_EXPORT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ya no manda `contact` crudo — el payload separa email/phone/otherContact
      // en vez del campo ambiguo (causa raíz del bug de producción).
      body: JSON.stringify({
        leadId: lead.leadId,
        conversationId: lead.conversationId,
        name: lead.name,
        email,
        phone,
        otherContact,
        intent: lead.intent,
        notes: lead.notes,
        channel: lead.channel,
        // Campo nuevo y opcional: el flujo de n8n lo ignora hasta que se mapee a Odoo (campaña / origen).
        ...(lead.adOrigin ? { adOrigin: lead.adOrigin } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    });
    // El workflow responde { ok: true, odoo_lead_id: <id numérico> } — ese es
    // el ID real del crm.lead recién creado en Odoo.
    const data = (await res.json()) as { ok?: boolean; odoo_lead_id?: number };
    if (data?.ok && data.odoo_lead_id != null) {
      return { exported: true, externalId: String(data.odoo_lead_id) };
    }
    return { exported: false };
  } catch (err) {
    console.error("[leadExport] export a Odoo falló:", err);
    return { exported: false };
  }
}

export interface ConversationSummaryInput {
  conversationId: string;
  channel: string;
  channelUserId: string;
  summary: string;
  topics: string[];
  saleOpportunity: boolean;
  lastMessageAt: number;
  /** Recordatorio que pidió el cliente (I-052), ya validado por `normalizarRecordatorio`. */
  reminder?: { fecha: string; motivo: string } | null;
}

/**
 * Manda el resumen de una conversación calificada por el Analista al mismo
 * webhook del Upsert, con `kind: "resumen"` (diseño v3, 30-oct-2026). Del
 * lado de n8n solo ACTUALIZA un lead que ya exista (nunca crea uno por un
 * resumen): último contacto, resumen y una fila de x_interaccion por día.
 * Fail-soft como exportLeadToOdoo: devuelve true/false, nunca lanza.
 */
export async function pushConversationSummary(env: Env, s: ConversationSummaryInput): Promise<boolean> {
  if (!env.LEAD_EXPORT_WEBHOOK_URL) return false;
  try {
    const res = await fetch(env.LEAD_EXPORT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "resumen",
        conversationId: s.conversationId,
        channel: s.channel,
        // En WhatsApp el id del canal ES el teléfono; en otros canales no.
        ...(s.channel === "whatsapp" ? { phone: s.channelUserId } : {}),
        summary: s.summary,
        topics: s.topics,
        saleOpportunity: s.saleOpportunity,
        lastMessageAt: new Date(s.lastMessageAt).toISOString(),
        ...(s.reminder ? { recordatorio: { fecha: s.reminder.fecha, motivo: s.reminder.motivo } } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as { ok?: boolean };
    return !!data?.ok;
  } catch (err) {
    console.error("[leadExport] resumen a Odoo falló:", err);
    return false;
  }
}
