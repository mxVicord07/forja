import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import {
  calcomConfigured,
  calcomTimeZone,
  getAvailableSlots,
  resolveEventTypeId,
} from "../integrations/calcom";

export function checkAvailabilityTool(env: Env) {
  return tool({
    description:
      "Consulta los horarios libres de un día para agendar. Úsala ANTES de agendar o de aceptar un cambio de horario, para no ofrecer un espacio que ya está ocupado.",
    inputSchema: z.object({
      fecha: z.string().describe("Día a consultar en formato YYYY-MM-DD"),
      servicio: z.string().optional().describe("Servicio que pide el cliente, si lo mencionó"),
    }),
    execute: async ({ fecha, servicio }) => {
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };
      const eventTypeId = resolveEventTypeId(env, servicio);
      if (eventTypeId === null) return { error: "calcom_not_configured" as const };

      const res = await getAvailableSlots(env, eventTypeId, fecha, calcomTimeZone(env));
      if (!res.ok) return { error: res.reason };
      return { ok: true as const, slots: res.slots };
    },
  });
}
