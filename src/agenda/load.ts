/**
 * Carga las citas del panel: una sola fuente por instalación. Cal.com manda; la
 * tabla propia solo aporta la conversación y el teléfono. Si Cal.com no está
 * configurado o falla, el panel usa la tabla propia y lo dice.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import { listBookings } from "../integrations/calcom";
import { normalizeCalBooking, mergeCitas, fromLocalRow, type CitaPanel } from "./source";

export interface CitasCargadas {
  citas: CitaPanel[];
  /** De dónde salió la lista: `calcom`, o `local` cuando Cal.com no estaba configurado o falló. */
  fuente: "calcom" | "local";
  /** Motivo por el que se usó la tabla propia (para mostrarlo en el panel). */
  aviso: string | null;
}

export async function cargarCitas(env: Env, rango: { desde: string; hasta: string }): Promise<CitasCargadas> {
  const repo = new AppointmentsRepo(new Db(env.DB));
  // Las filas propias se leen siempre: sirven para ligar y como respaldo. Si la base falla, no se tumba el panel.
  const locales = await repo.listBetween(rango.desde, rango.hasta).catch(() => []);

  const res = await listBookings(env, { afterStart: rango.desde, beforeEnd: rango.hasta });
  if (res.ok) {
    const cal = res.bookings.map(normalizeCalBooking).filter((c): c is CitaPanel => c !== null);
    return { citas: mergeCitas(cal, locales), fuente: "calcom", aviso: null };
  }

  const aviso =
    res.reason === "not_configured"
      ? "Cal.com no está conectado: se muestran solo las citas que agendó el asistente."
      : "No se pudo leer Cal.com (" + res.reason + "): se muestran solo las citas que agendó el asistente.";
  return { citas: locales.map(fromLocalRow), fuente: "local", aviso };
}
