import type { Env } from "../env";

export interface ParsedContact {
  email?: string;
  phone?: string;
  otherContact?: string;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/;
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

  // Limpia separadores sueltos que quedaron entre las partes removidas
  // ("/", ",", " y ", espacios extra) y basura de puntuación pura.
  const leftover = rest
    .replace(/[/,]/g, " ")
    .replace(/\by\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (leftover.length > 2 && /[a-zA-Z0-9]/.test(leftover)) {
    result.otherContact = leftover;
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
