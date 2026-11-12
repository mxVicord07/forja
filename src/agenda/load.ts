/**
 * Carga las citas del panel con UNA sola fuente por instalación:
 *   1. Odoo (por n8n) si CRM_AGENDA_URL está definida: junta Outlook, el Copiloto y Cal.com.
 *   2. Cal.com si no hay Odoo o si Odoo falla.
 *   3. La tabla propia si tampoco hay Cal.com.
 * La tabla propia nunca agrega filas: solo liga la conversación y el teléfono.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import { listBookings } from "../integrations/calcom";
import { normalizeCalBooking, mergeCitas, fromLocalRow, type CitaPanel } from "./source";
import { listOdooCitas, ligarConversaciones, odooAgendaConfigured } from "./odoo";

export interface CitasCargadas {
  citas: CitaPanel[];
  /** De dónde salió la lista. */
  fuente: "odoo" | "calcom" | "local";
  /** Motivo por el que se cayó a una fuente de respaldo (para mostrarlo en el panel). */
  aviso: string | null;
}

export async function cargarCitas(env: Env, rango: { desde: string; hasta: string }): Promise<CitasCargadas> {
  const repo = new AppointmentsRepo(new Db(env.DB));
  // Las filas propias se leen siempre: sirven para ligar y como respaldo. Si la base falla, no se tumba el panel.
  const locales = await repo.listBetween(rango.desde, rango.hasta).catch(() => []);

  let avisoOdoo: string | null = null;
  if (odooAgendaConfigured(env)) {
    const o = await listOdooCitas(env, rango);
    if (o.ok) return { citas: ligarConversaciones(o.citas, locales), fuente: "odoo", aviso: null };
    avisoOdoo = `No se pudo leer el calendario de Odoo (${o.reason}): se muestran solo las reservas de Cal.com.`;
  }

  const res = await listBookings(env, { afterStart: rango.desde, beforeEnd: rango.hasta });
  if (res.ok) {
    const cal = res.bookings.map(normalizeCalBooking).filter((c): c is CitaPanel => c !== null);
    return { citas: mergeCitas(cal, locales), fuente: "calcom", aviso: avisoOdoo };
  }

  const aviso =
    res.reason === "not_configured"
      ? "Cal.com no está conectado: se muestran solo las citas que agendó el asistente."
      : "No se pudo leer Cal.com (" + res.reason + "): se muestran solo las citas que agendó el asistente.";
  return { citas: locales.map(fromLocalRow), fuente: "local", aviso: avisoOdoo ? `${avisoOdoo} ${aviso}` : aviso };
}
