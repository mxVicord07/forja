import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import {
  calcomConfigured,
  calcomTimeZone,
  createBooking,
  resolveEventTypeId,
} from "../integrations/calcom";

export function scheduleAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Agenda una cita en el calendario. Confirma primero el horario con checkAvailability. Necesitas fecha/hora, nombre y correo del cliente. " +
      "Si devuelve appointment_already_exists, el cliente YA tiene una cita: no insistas en agendar otra — ofrécele mover la que tiene con rescheduleAppointment.",
    inputSchema: z.object({
      startTime: z.string().describe("Fecha y hora ISO, ej. 2026-07-20T15:00:00Z"),
      attendeeName: z.string().describe("Nombre del cliente"),
      attendeeEmail: z.string().email().describe("Correo del cliente"),
      attendeePhone: z.string().optional().describe("Teléfono del cliente, si lo dio"),
      servicio: z.string().optional().describe("Servicio que pidió, si lo mencionó"),
      notes: z.string().optional().describe("Notas para el dueño"),
    }),
    execute: async ({ startTime, attendeeName, attendeeEmail, attendeePhone, servicio, notes }) => {
      const conversationId = getConversationId();
      if (!conversationId) return { error: "no_conversation" as const };
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };

      // Una cita activa por contacto. Sin este candado, un cliente podría
      // acumular varias y ni el bot ni el dueño sabrían a cuál se refiere
      // cuando pida "cambiar mi cita".
      const appts = new AppointmentsRepo(new Db(env.DB));
      const existente = await appts.findActive(conversationId);
      if (existente) {
        return { error: "appointment_already_exists" as const, existingStart: existente.start };
      }

      const eventTypeId = resolveEventTypeId(env, servicio);
      if (eventTypeId === null) return { error: "calcom_not_configured" as const };

      const booking = await createBooking(env, {
        eventTypeId,
        start: startTime,
        name: attendeeName,
        email: attendeeEmail,
        timeZone: calcomTimeZone(env),
        phone: attendeePhone,
        notes,
      });
      // Solo persistimos si Cal.com confirmó: una fila sin booking real dejaría
      // al bot creyendo que el cliente tiene cita cuando no la tiene.
      if (!booking.ok) return { error: booking.reason };

      await appts.create({
        conversationId,
        calcomUid: booking.uid,
        eventTypeId,
        start: booking.start ?? startTime,
        attendeeName,
        attendeeEmail,
        attendeePhone,
      });

      return {
        ok: true as const,
        bookingId: booking.bookingId,
        uid: booking.uid,
        start: booking.start ?? startTime,
      };
    },
  });
}
