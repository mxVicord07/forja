import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";
import { exportLeadToOdoo } from "../tools/leadExport";

/** Reintenta exportar leads dentro de esta ventana; más viejos que esto se dan por perdidos. */
export const RECONCILE_WINDOW_HOURS = 72;
const BATCH_LIMIT = 50;

/**
 * Cron horario: reintenta exportar a Odoo los leads que quedaron sin exportar
 * (webhook caído, timeout, respuesta inválida, etc.) — cubre el caso en que
 * exportLeadToOdoo falló en el momento de captureLead. Ventana de 72h, hasta
 * 50 leads por tick para no desbordar un solo tick del cron.
 *
 * Nunca truena por un lead individual — captura errores por lead y sigue con
 * los demás; un fallo aislado no debe tumbar el resto de scheduled().
 */
export async function reconcileExportedLeads(env: Env): Promise<void> {
  const leads = new LeadsRepo(new Db(env.DB));
  const since = Date.now() - RECONCILE_WINDOW_HOURS * 60 * 60 * 1000;
  const candidates = await leads.listUnexported(since, BATCH_LIMIT);

  let succeeded = 0;
  let failed = 0;

  for (const lead of candidates) {
    try {
      // `leads` no tiene columna `channel` propia, pero conversation_id tiene
      // la forma "<channel>:<channelUserId>" (db/conversations.ts) — se
      // recupera el canal real de ahí sin tocar el schema ni hacer un JOIN.
      const channel = lead.conversation_id?.split(":")[0] || "unknown";
      const { exported, externalId } = await exportLeadToOdoo(env, {
        leadId: lead.id,
        conversationId: lead.conversation_id,
        name: lead.name ?? undefined,
        contact: lead.contact ?? undefined,
        intent: lead.intent,
        notes: lead.notes ?? undefined,
        channel,
      });
      if (exported) {
        await leads.setExported(lead.id, "odoo", externalId!);
        succeeded++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(`[cron reconcileExportedLeads] lead ${lead.id} falló:`, err);
    }
  }

  console.log(
    `[cron reconcileExportedLeads] reintentados ${candidates.length}, exportados ${succeeded}, siguen fallando ${failed}`,
  );
}
