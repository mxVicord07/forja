import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";

export function captureLeadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Captura un lead (cliente interesado) para que el dueño venda después. Guarda en D1 + opcionalmente lo exporta a Odoo (vía webhook n8n) si LEAD_EXPORT_WEBHOOK_URL está configurado.",
    inputSchema: z.object({
      name: z.string().optional().describe("Nombre del cliente"),
      contact: z.string().optional().describe("Teléfono o email"),
      intent: z.string().describe("Qué quiere el cliente, en 1-2 frases"),
      notes: z.string().optional(),
    }),
    execute: async ({ name, contact, intent, notes }) => {
      const convId = getConversationId();
      const leads = new LeadsRepo(new Db(env.DB));
      const leadId = await leads.create({
        conversationId: convId,
        name,
        contact,
        channelUserId: null,
        intent,
        notes,
      });

      // Optional external export — hoy: push a Odoo BIRevX vía workflow n8n
      // (BIRevX_Forja_Lead_to_Odoo). Nunca bloquea ni rompe la respuesta al
      // usuario: si el webhook falla, no responde JSON, o no está
      // configurado, el lead ya quedó a salvo en D1 arriba.
      if (env.LEAD_EXPORT_WEBHOOK_URL) {
        try {
          const res = await fetch(env.LEAD_EXPORT_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              leadId,
              conversationId: convId,
              name,
              contact,
              intent,
              notes,
              channel: env.BOT_NAME,
            }),
          });
          // El workflow responde { ok: true, odoo_lead_id: <id numérico> } —
          // ese es el ID real del crm.lead recién creado en Odoo.
          const data = (await res.json()) as { ok?: boolean; odoo_lead_id?: number };
          if (data?.ok && data.odoo_lead_id != null) {
            await leads.setExported(leadId, "odoo", String(data.odoo_lead_id));
          }
        } catch (err) {
          console.error("[captureLead] export a Odoo falló:", err);
        }
      }

      return { leadId, message: "Lead capturado." };
    },
  });
}
