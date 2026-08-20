import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";
import { exportLeadToOdoo } from "./leadExport";

export function captureLeadTool(
  env: Env,
  getConversationId: () => string | null,
  getChannel: () => string | null,
) {
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

      // Export opcional a Odoo (vía workflow n8n BIRevX_Forja_Lead_to_Odoo).
      // Fail-soft: exportLeadToOdoo nunca truena, así que esto nunca bloquea
      // ni rompe la respuesta al usuario — el lead ya quedó a salvo en D1.
      const { exported, externalId } = await exportLeadToOdoo(env, {
        leadId,
        conversationId: convId,
        name,
        contact,
        intent,
        notes,
        channel: getChannel() ?? env.BOT_NAME,
      });
      // try/catch propio: si setExported falla (D1), NO debe propagarse — un
      // throw aquí tumba la generación, dispara el failover de agent.ts, y el
      // modelo re-ejecuta esta misma tool (segundo lead + segunda exportación).
      // El lead ya está a salvo en D1; el cron de reconciliación lo recoge.
      if (exported) {
        try {
          await leads.setExported(leadId, "odoo", externalId!);
        } catch (err) {
          console.error("[captureLead] setExported falló (D1):", err);
        }
      }

      return { leadId, message: "Lead capturado." };
    },
  });
}
