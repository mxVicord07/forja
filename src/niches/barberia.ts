import type { NichePack } from "./types";
import { AGENDA_PLAYBOOK } from "./agendaPlaybook";

// Nicho: Barbería / peluquería masculina / grooming. El bot es la recepción: cotiza
// servicios desde la KB, dice horarios y ubicación, y agenda citas (el cliente suele
// pedir por barbero). Rápido y al grano — la gente que escribe a una barbería quiere
// resolver ya. Usa la tool de citas (ver agendaPlaybook.ts).
export const barberia: NichePack = {
  id: "barberia",
  recordSingular: "Cita",
  recordPlural: "Citas",
  navLabel: "Citas",
  navIcon: "scissors",
  kpiLabel: "Citas",
  // solicitada → confirmada → atendida → cancelada (mapeadas a los 4 canónicos)
  statusLabels: {
    new: "Solicitada",
    contacted: "Confirmada",
    sold: "Atendida",
    lost: "Cancelada",
  },
  columns: [
    { key: "servicio", label: "Servicio" },
    { key: "profesional", label: "Barbero" },
    { key: "fecha", label: "Fecha" },
    { key: "hora", label: "Hora" },
  ],
  defaultTone: "cercano y relajado, como hablarle a un cliente de confianza — corto y directo",
  kbDocs: ["servicios-y-precios", "horarios-y-ubicacion", "como-agendar-y-cancelar", "nuestros-barberos", "pagos-y-promos"],
  playbook: `<diagnostic_playbooks>
<playbook name="precio_corte">
Cliente pregunta cuánto cuesta un corte/barba o qué precios manejan. Llama
searchKb("servicios y precios") y da el precio del servicio que pidió. Si no
especifica, ofrece los 2-3 más pedidos (corte, corte+barba, barba). NO inventes
precios: si un servicio no está en la KB, dilo y ofrece handoffHuman para cotizar.
</playbook>

<playbook name="agendar_cita">
Cliente quiere cita o pregunta si hay lugar. Pide en pocos turnos: servicio, día y
hora, y su nombre. Si pidió un barbero en particular, anótalo. Con esos datos llama
la tool de citas. Si la barbería acepta walk-in (business_context/KB), dilo, pero
recomienda agendar para no esperar en hora pico (sábado por la tarde). Confirma que
quedó REGISTRADA y que la barbería la confirma.
</playbook>

<playbook name="barbero_especifico">
Cliente pide con un barbero por nombre ("quiero con Memo"). Revisa la KB
("nuestros-barberos"). Si existe, confírmalo y agéndalo con esa persona (campo
profesional en la tool de citas). Si no, di los barberos disponibles.
</playbook>

<playbook name="horario_ubicacion">
Cliente pregunta a qué hora abren/cierran, si abren domingo, o dónde están. Llama
searchKb("horarios y ubicación") y responde con el dato exacto del día que pregunte.
Comparte la referencia y el link de Maps cuando convenga. Si ese día cierran, dilo y
ofrece el siguiente día disponible.
</playbook>

<playbook name="cancelar_reagendar">
Cliente quiere cancelar o mover su cita. Recuerda la política (searchKb) — típico
avisar con 2 horas de anticipación. Si es un cambio simple, ayúdalo (la tool de citas con
los nuevos datos). Si está molesto o se complica → handoffHuman.
</playbook>

${AGENDA_PLAYBOOK}
</diagnostic_playbooks>`,
};
