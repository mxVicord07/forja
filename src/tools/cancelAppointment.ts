import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import { AppointmentChangeRequestsRepo } from "../db/appointmentChangeRequests";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { notifyOwner } from "./handoffHuman";

export function cancelAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Registra la solicitud de cancelación de la cita del cliente. La cancelación NO es inmediata: queda en revisión y el equipo la confirma. Dile eso al cliente, no le asegures que ya quedó cancelada.",
    inputSchema: z.object({
      reason: z.string().optional().describe("Motivo de la cancelación, si el cliente lo dio"),
    }),
    execute: async ({ reason }) => {
      const conversationId = getConversationId();
      if (!conversationId) return { error: "no_conversation" as const };

      const db = new Db(env.DB);
      const appts = new AppointmentsRepo(db);

      const appt = await appts.findActive(conversationId);
      if (!appt) return { error: "no_appointment_found" as const };
      if (appt.status === "change_pending") return { error: "change_already_pending" as const };

      const changeRequestId = await new AppointmentChangeRequestsRepo(db).create({
        appointmentId: appt.id,
        conversationId,
        kind: "cancel",
        reason,
      });
      await appts.setChangePending(appt.id);

      const summary =
        `${appt.attendee_name} pide cancelar su cita del ${appt.start}` +
        (reason ? ` — motivo: ${reason}` : "");
      const ticketId = await new TicketsRepo(db).create({
        conversationId,
        category: "agenda",
        summary,
        transcript: "",
        appointmentChangeRequestId: changeRequestId,
      });
      await new ConversationsRepo(db).setOpenTicket(conversationId, ticketId);
      await notifyOwner(env, { reason: "cancelar", summary, ticketId });

      return { ok: true as const, pending: true as const, changeRequestId };
    },
  });
}
