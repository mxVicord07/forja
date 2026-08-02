import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import { AppointmentChangeRequestsRepo } from "../db/appointmentChangeRequests";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { notifyOwner } from "./handoffHuman";
import { calcomConfigured, calcomTimeZone, getAvailableSlots } from "../integrations/calcom";

/**
 * Tope duro de reagendamientos por cita. Al cuarto intento el bot deja de
 * generar solicitudes y escala a un humano: el patrón (mismo cliente, misma
 * cita, moviéndose otra vez) amerita una conversación real, no otro clic de
 * aprobación.
 */
export const MAX_RESCHEDULES = 3;

export function rescheduleAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Solicita mover la cita del cliente a otro horario. El cambio NO es inmediato: queda en revisión y el equipo lo confirma. " +
      "Si devuelve reschedule_limit_reached, no lo intentes de nuevo — usa handoffHuman para pasar la conversación a una persona. " +
      "Si devuelve slot_unavailable, ofrécele al cliente los horarios que vienen en `available`.",
    inputSchema: z.object({
      newStartTime: z.string().describe("Nuevo horario propuesto, ISO, ej. 2026-07-25T16:00:00Z"),
      reason: z.string().optional().describe("Motivo del cambio, si el cliente lo dio"),
    }),
    execute: async ({ newStartTime, reason }) => {
      const conversationId = getConversationId();
      if (!conversationId) return { error: "no_conversation" as const };
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };

      const db = new Db(env.DB);
      const appts = new AppointmentsRepo(db);
      const changes = new AppointmentChangeRequestsRepo(db);

      const appt = await appts.findActive(conversationId);
      if (!appt) return { error: "no_appointment_found" as const };
      if (appt.status === "change_pending") return { error: "change_already_pending" as const };

      const already = await changes.countApproved(appt.id, "reschedule");
      if (already >= MAX_RESCHEDULES) {
        return { error: "reschedule_limit_reached" as const, timesRescheduled: already };
      }

      // Validar contra el calendario ANTES de molestar al dueño: así nunca
      // llega a aprobación una solicitud sobre un horario ya ocupado. Se usa
      // el event type de la cita existente, no el default: reagendar mantiene
      // el mismo servicio que el cliente ya había apartado.
      const day = newStartTime.slice(0, 10);
      const slots = await getAvailableSlots(env, appt.event_type_id, day, calcomTimeZone(env));
      if (!slots.ok) return { error: slots.reason };
      if (!slots.slots.some((s) => sameInstant(s, newStartTime))) {
        return { error: "slot_unavailable" as const, available: slots.slots };
      }

      const changeRequestId = await changes.create({
        appointmentId: appt.id,
        conversationId,
        kind: "reschedule",
        proposedStart: newStartTime,
        reason,
      });
      await appts.setChangePending(appt.id);

      const summary =
        `${appt.attendee_name} pide mover su cita del ${appt.start} al ${newStartTime}` +
        (reason ? ` — motivo: ${reason}` : "");
      const ticketId = await new TicketsRepo(db).create({
        conversationId,
        category: "agenda",
        summary,
        transcript: "",
        appointmentChangeRequestId: changeRequestId,
      });
      await new ConversationsRepo(db).setOpenTicket(conversationId, ticketId);
      await notifyOwner(env, { reason: "reagendar", summary, ticketId });

      return { ok: true as const, pending: true as const, changeRequestId, proposedStart: newStartTime };
    },
  });
}

/**
 * Compara dos instantes ISO. Cal.com devuelve los slots con offset local
 * ("2026-07-25T10:00:00.000-06:00") y el modelo suele proponer en UTC — una
 * comparación de strings diría que son distintos siendo el mismo momento.
 */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}
