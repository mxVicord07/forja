import type { Env } from "../env";
import { isPro } from "../config";
import { searchKbTool, type SearchKbResult } from "./searchKb";
import { shareDocumentTool } from "./shareDocument";
import type { DocumentRow } from "../db/documents";
import { handoffHumanTool } from "./handoffHuman";
import { pauseBotTool } from "./pauseBot";
import { snoozeUserTool } from "./snoozeUser";
import { captureLeadTool } from "./captureLead";
import { scheduleAppointmentTool } from "./scheduleAppointment";
import { catalogQueryTool } from "./catalogQuery";
import { checkAvailabilityTool } from "./checkAvailability";
import { rescheduleAppointmentTool } from "./rescheduleAppointment";
import { cancelAppointmentTool } from "./cancelAppointment";
import { sendPaymentLinkTool } from "./cobros";
import { stripeConfigured } from "../integrations/stripe";

export interface ToolContext {
  env: Env;
  getConversationId: () => string | null;
  /** Blindaje/selector de modelo: se entera de qué trajo searchKb ESTE turno. */
  onSearchKb?: (results: SearchKbResult[]) => void;
  /** El agente se entera de qué documento hay que mandar tras el texto (ver shareDocument.ts). */
  onShareDocument?: (doc: DocumentRow) => void;
  /** Canal real de la conversación (telegram, whatsapp…) — usado por captureLead al exportar.
   *  Opcional para no romper callers que solo listan nombres de tools (admin/*); si falta,
   *  captureLeadTool cae a env.BOT_NAME como antes. */
  getChannel?: () => string | null;
}

export function buildTools(ctx: ToolContext) {
  // Free tier base set. captureLead y scheduleAppointment van aquí a propósito: el bot
  // Starter (free) captura prospectos Y agenda citas — Cal.com lo pone el dueño con su
  // propia cuenta/llave, sin costo para Forja, así que es valor central sin gate. Lo Pro
  // es consultar catálogo/inventario y las tools avanzadas por nicho.
  const tools: Record<string, any> = {
    searchKb: searchKbTool(ctx.env, ctx.onSearchKb),
    handoffHuman: handoffHumanTool(ctx.env, ctx.getConversationId),
    pauseBot: pauseBotTool(ctx.env, ctx.getConversationId),
    snoozeUser: snoozeUserTool(ctx.env, ctx.getConversationId),
    captureLead: captureLeadTool(ctx.env, ctx.getConversationId, ctx.getChannel ?? (() => null)),
    // No es Pro-only a propósito: compartir un PDF de precios es infra básica
    // de ventas, igual que captureLead — no consume tokens de visión ni cuesta
    // más que un mensaje normal.
    shareDocument: shareDocumentTool(ctx.env, ctx.onShareDocument),
  };

  // Pro tier additions
  if (isPro(ctx.env)) {
    // NOTA (merge upstream 2026-09-10): upstream movió scheduleAppointment al tier
    // free con una tool combinada (consulta + reserva, sin persistencia). Acá se
    // conserva la suite de 4 tools: agendar escribe en `appointments` (D1) y
    // reagendar/cancelar dependen de esa fila + los tickets de aprobación. Un bot
    // free con reserva pero sin consulta de horarios no tendría sentido, así que
    // las 4 siguen juntas en Pro. Lo que SÍ se adoptó del cambio de upstream es
    // la resolución de fechas relativas en el servidor (src/time/resolveDate).
    tools.checkAvailability = checkAvailabilityTool(ctx.env);
    tools.scheduleAppointment = scheduleAppointmentTool(ctx.env, ctx.getConversationId);
    tools.rescheduleAppointment = rescheduleAppointmentTool(ctx.env, ctx.getConversationId);
    tools.cancelAppointment = cancelAppointmentTool(ctx.env, ctx.getConversationId);
    tools.catalogQuery = catalogQueryTool(ctx.env);
    // Cobros por WhatsApp (skill /cobros): registrada solo si el dueño conectó
    // su propia llave de Stripe — sin ella la tool no tiene nada que hacer.
    // El opt-in REAL (payments_enabled) se aplica después, en settings-loader
    // (enabledToolNames) — esto solo decide si la tool EXISTE en principio.
    if (stripeConfigured(ctx.env)) {
      tools.sendPaymentLink = sendPaymentLinkTool(ctx.env, ctx.getConversationId);
    }
  }

  return tools;
}
