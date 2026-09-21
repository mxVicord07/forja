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
import { localTimeToUtcIso, resolveDateInput, todayInTz } from "../time/resolveDate";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Agendar una cita. Se conserva el ciclo propio (candado de una cita activa por
 * contacto + persistencia en `appointments`, de la que dependen reagendar y
 * cancelar). La fecha Y la hora se resuelven EN EL SERVIDOR, nunca las
 * calcula el modelo:
 *
 * - Fecha: adoptado del upstream — el modelo cuenta mal "el próximo martes" y
 *   mandaba un YYYY-MM-DD equivocado con toda confianza.
 * - Hora/UTC: hallazgo propio (20-sep-2026, birevx-support-bot en vivo). Antes
 *   se le pedía al modelo un ISO completo con "Z" (ej. "2026-07-20T15:00:00Z")
 *   — para eso tiene que convertir la hora local del negocio a UTC él mismo, y
 *   se equivocó: mandó "10:00:00Z" pensando "las 10am" en México (UTC-6, la
 *   hora real era las 16:00Z). La cita se intentó a las 4am, fuera de
 *   horario; Cal.com respondió 409 y el modelo interpretó ESO (sin
 *   verificarlo) como "el cliente ya tiene otra cita" — una segunda
 *   invención encima de la primera. Ahora el modelo solo dice la hora LOCAL
 *   tal como la entendió ("10:00"), y `localTimeToUtcIso` hace la conversión
 *   real con el offset de la zona del negocio.
 */
export function scheduleAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Agenda una cita en el calendario. Confirma primero el horario con checkAvailability. Necesitas fecha/hora, nombre y correo del cliente. " +
      "Pasa en `date` la fecha CON LAS PALABRAS DEL CLIENTE ('el próximo martes', 'mañana'); NO la conviertas tú a YYYY-MM-DD — el servidor la resuelve. " +
      "Pasa en `time` la hora LOCAL del negocio tal como la entendiste ('10:00', '15:30'); NUNCA la conviertas a UTC ni agregues 'Z' — el servidor hace esa conversión. " +
      "Si devuelve appointment_already_exists, el cliente YA tiene una cita: no insistas en agendar otra — ofrécele mover la que tiene con rescheduleAppointment.",
    inputSchema: z.object({
      date: z
        .string()
        .describe(
          "Fecha tal como la dijo el cliente ('el próximo martes', 'mañana') o YYYY-MM-DD " +
            "solo si dio día y mes. No calcules YYYY-MM-DD a partir de un día de la semana.",
        ),
      time: z
        .string()
        .describe(
          'Hora en formato 24h "HH:mm", en la hora LOCAL del negocio tal como la entendiste del ' +
            'cliente (ej. "10:00" para las 10 de la mañana, "15:30" para las 3:30 de la tarde). ' +
            'NUNCA la conviertas a UTC ni escribas "Z" — el servidor hace esa conversión con la ' +
            "zona horaria real del negocio.",
        ),
      attendeeName: z.string().describe("Nombre del cliente"),
      attendeeEmail: z.string().email().describe("Correo del cliente"),
      attendeePhone: z.string().optional().describe("Teléfono del cliente, si lo dio"),
      servicio: z.string().optional().describe("Servicio que pidió, si lo mencionó"),
      notes: z.string().optional().describe("Notas para el dueño"),
    }),
    execute: async ({
      date,
      time,
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

      const timeZone = calcomTimeZone(env);
      const locale = (env.BOT_LANGUAGE || "es").slice(0, 2);
      const today = todayInTz(timeZone);
      const resolved = resolveDateInput(date, { timeZone, locale });
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

      const timeTrimmed = time.trim();
      if (!TIME_RE.test(timeTrimmed)) {
        return {
          error: "invalid_time" as const,
          hint: 'Usa formato 24h "HH:mm" en hora LOCAL del negocio, ej. "10:00" o "15:30" — sin UTC ni "Z".',
        };
      }
      const bookedStart = localTimeToUtcIso(resolved.date, timeTrimmed, timeZone);

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
