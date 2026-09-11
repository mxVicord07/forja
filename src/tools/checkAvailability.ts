import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import {
  calcomConfigured,
  calcomTimeZone,
  getAvailableSlots,
  resolveEventTypeId,
} from "../integrations/calcom";
import { resolveDateInput, todayInTz } from "../time/resolveDate";

/**
 * Horarios libres de un día. La fecha se resuelve EN EL SERVIDOR (adoptado del
 * upstream, commit "fechas relativas se resuelven en el servidor"): el modelo
 * cuenta mal "el próximo martes" y consultaba el día equivocado con toda
 * confianza — el cliente recibía horarios de otro día. Se acepta el texto del
 * cliente y también un YYYY-MM-DD ya formado, pero el resolvedor manda.
 */
export function checkAvailabilityTool(env: Env) {
  return tool({
    description:
      "Consulta los horarios libres de un día para agendar. Úsala ANTES de agendar o de aceptar un cambio de horario, para no ofrecer un espacio que ya está ocupado. " +
      "Pasa en `fecha` lo que dijo el cliente ('el próximo martes', 'mañana'): NO lo conviertas tú a YYYY-MM-DD, el servidor lo resuelve.",
    inputSchema: z.object({
      fecha: z
        .string()
        .describe(
          "Día a consultar, con las palabras del cliente ('el próximo martes', 'mañana') " +
            "o YYYY-MM-DD solo si dio día y mes",
        ),
      servicio: z.string().optional().describe("Servicio que pide el cliente, si lo mencionó"),
    }),
    execute: async ({ fecha, servicio }) => {
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };
      const eventTypeId = resolveEventTypeId(env, servicio);
      if (eventTypeId === null) return { error: "calcom_not_configured" as const };

      const timeZone = calcomTimeZone(env);
      const locale = (env.BOT_LANGUAGE || "es").slice(0, 2);
      const today = todayInTz(timeZone);
      const resolved = resolveDateInput(fecha, { timeZone, locale });
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

      const res = await getAvailableSlots(env, eventTypeId, resolved.date, timeZone);
      if (!res.ok) return { error: res.reason };
      return {
        ok: true as const,
        fecha: resolved.date,
        weekday: resolved.weekday,
        timeZone,
        slots: res.slots,
      };
    },
  });
}
