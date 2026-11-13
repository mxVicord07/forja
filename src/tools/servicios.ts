import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";

// Tool de los giros de SERVICIOS POR CITA (barbería, salón, spa, clínica,
// dentista, gimnasio, coach), portada de Forja+ v1.0.51 (`agendarCita`).
//
// Solo se trae la mitad ligera: registra la SOLICITUD de cita como lead, con
// los datos del giro en metadata (servicio, profesional, fecha, hora) para que
// la tabla del panel la muestre como «Cita». La mitad de Cal.com de Forja+ se
// queda fuera a propósito: este fork ya agenda con checkAvailability /
// scheduleAppointment / rescheduleAppointment / cancelAppointment. Por eso
// tools/index.ts registra esta tool SOLO cuando el bot no tiene agenda
// (agendaDisponible = false): nunca hay dos formas de agendar a la vez.
export function registrarCitaTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Registra una SOLICITUD DE CITA cuando el cliente ya dio el servicio que quiere, el día, la hora y su nombre. El negocio la confirma después: no la des por confirmada tú.",
    inputSchema: z.object({
      nombre: z.string().describe("Nombre de quien agenda"),
      servicio: z
        .string()
        .describe(
          "Servicio o motivo de la cita, tal como lo pidió (ej. 'corte + barba', 'limpieza dental', 'clase de prueba', 'llamada de descubrimiento')",
        ),
      fecha: z.string().describe("Día de la cita, tal como lo dijo el cliente (ej. 'sábado', '20 de julio')"),
      hora: z.string().describe("Hora de la cita (ej. '5pm', '17:00')"),
      profesional: z
        .string()
        .optional()
        .describe("Con quién quiere la cita, si pidió a alguien en particular (barbero, estilista, doctor, coach)"),
      contacto: z.string().optional().describe("Teléfono del cliente si lo dio"),
      notas: z.string().optional().describe("Detalles extra (primera vez, urgencia, meta que busca, cambio de una cita anterior, etc.)"),
    }),
    execute: async ({ nombre, servicio, fecha, hora, profesional, contacto, notas }) => {
      const metadata: Record<string, string> = { servicio, fecha, hora };
      if (profesional) metadata.profesional = profesional;
      const leads = new LeadsRepo(new Db(env.DB));
      const id = await leads.create({
        conversationId: getConversationId(),
        channelUserId: null,
        name: nombre,
        contact: contacto,
        intent: `Cita · ${servicio} · ${fecha} ${hora}`.slice(0, 300),
        notes: [profesional ? `Con: ${profesional}` : "", notas ?? ""].filter(Boolean).join(" · ") || undefined,
        metadata,
      });
      return { citaId: id, message: "Cita registrada. El negocio la confirma." };
    },
  });
}
