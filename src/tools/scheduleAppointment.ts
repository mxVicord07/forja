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
import { applyResolvedDate, resolveDateInput, todayInTz } from "../time/resolveDate";

/**
 * Agendar una cita. Se conserva el ciclo propio (candado de una cita activa por
 * contacto + persistencia en `appointments`, de la que dependen reagendar y
 * cancelar), y se adopta del upstream la pieza que sí era un bug real: la fecha
 * relativa se resuelve EN EL SERVIDOR, no en el modelo. El modelo cuenta mal
 * "el próximo martes" y mandaba un YYYY-MM-DD equivocado con toda confianza.
 */
export function scheduleAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Agenda una cita en el calendario. Confirma primero el horario con checkAvailability. Necesitas fecha/hora, nombre y correo del cliente. " +
      "Pasa en `date` la fecha CON LAS PALABRAS DEL CLIENTE ('el próximo martes', 'mañana'); NO la conviertas tú a YYYY-MM-DD — el servidor la resuelve. " +
      "Si devuelve appointment_already_exists, el cliente YA tiene una cita: no insistas en agendar otra — ofrécele mover la que tiene con rescheduleAppointment.",
    inputSchema: z.object({
      startTime: z.string().describe("Fecha y hora ISO, ej. 2026-07-20T15:00:00Z"),
      date: z
        .string()
        .optional()
        .describe(
          "Fecha tal como la dijo el cliente ('el próximo martes', 'mañana') o YYYY-MM-DD " +
            "solo si dio día y mes. No calcules YYYY-MM-DD a partir de un día de la semana.",
        ),
      attendeeName: z.string().describe("Nombre del cliente"),
      attendeeEmail: z.string().email().describe("Correo del cliente"),
      attendeePhone: z.string().optional().describe("Teléfono del cliente, si lo dio"),
      servicio: z.string().optional().describe("Servicio que pidió, si lo mencionó"),
      notes: z.string().optional().describe("Notas para el dueño"),
    }),
    execute: async ({
      startTime,
      date,
      attendeeName,
      attendeeEmail,
      attendeePhone,
      servicio,
      notes,
    }) => {
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

      // La fecha civil la fija el servidor. Si `date` trae palabras, gana sobre
      // el YYYY-MM-DD que venga dentro de `startTime`; la hora y el offset de
      // `startTime` se conservan intactos.
      const timeZone = calcomTimeZone(env);
      const locale = (env.BOT_LANGUAGE || "es").slice(0, 2);
      const today = todayInTz(timeZone);
      const toResolve = date || startTime.slice(0, 10);
      const resolved = resolveDateInput(toResolve, { timeZone, locale });
      if (!resolved.ok) {
        return {
          error: resolved.error,
          today,
          hint: `Hoy es ${today}. Pasa la fecha con las palabras del cliente (ej. 'el próximo martes') o un YYYY-MM-DD de calendario.`,
        };
      }
      if (resolved.date < today) {
        return {
          error: "date_in_past" as const,
          today,
          weekday: resolved.weekday,
          hint: `Hoy es ${today}. Recalcula la fecha pedida por el cliente a partir de hoy y reintenta.`,
        };
      }
      const bookedStart = applyResolvedDate(startTime, resolved.date);

      const booking = await createBooking(env, {
        eventTypeId,
        start: bookedStart,
        name: attendeeName,
        email: attendeeEmail,
        timeZone,
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
        start: booking.start ?? bookedStart,
        attendeeName,
        attendeeEmail,
        attendeePhone,
      });

      return {
        ok: true as const,
        bookingId: booking.bookingId,
        uid: booking.uid,
        start: booking.start ?? bookedStart,
        date: resolved.date,
        weekday: resolved.weekday,
      };
    },
  });
}
