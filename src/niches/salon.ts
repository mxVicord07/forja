import type { NichePack } from "./types";
import { AGENDA_PLAYBOOK } from "./agendaPlaybook";

// Nicho: Salón de belleza / estética. El bot cotiza servicios (corte, color, uñas,
// pestañas, novia), explica anticipos de servicios largos y agenda citas. No promete
// resultados de color ni da consejo dermatológico por chat. Usa la tool de citas.
export const salon: NichePack = {
  id: "salon",
  recordSingular: "Cita",
  recordPlural: "Citas",
  navLabel: "Citas",
  navIcon: "sparkles",
  kpiLabel: "Citas",
  statusLabels: {
    new: "Solicitada",
    contacted: "Confirmada",
    sold: "Atendida",
    lost: "Cancelada",
  },
  columns: [
    { key: "servicio", label: "Servicio" },
    { key: "profesional", label: "Con" },
    { key: "fecha", label: "Fecha" },
    { key: "hora", label: "Hora" },
  ],
  defaultTone: "cálido y con buen gusto — asesora sin presionar, hace sentir a gusto",
  kbDocs: ["servicios", "horarios", "politicas", "productos", "novias-eventos"],
  playbook: `<diagnostic_playbooks>
<playbook name="agendar_cita">
Cliente quiere agendar. Pide: servicio, día/hora preferida y nombre. Con eso llama
la tool de citas. Si el servicio es largo (color, mechas, keratina, novia, juego de
acrílico/pestañas), recuérdale el anticipo del 50% antes de darla por registrada.
Confirma que el salón confirma la cita.
</playbook>

<playbook name="precio_servicio">
Cliente pregunta precio. Llama searchKb("precios/servicios") y cita la tabla. Para
color o mechas aclara que el precio final varía según largo y densidad del cabello, y
ofrece una valoración sin costo. Si el servicio NO está listado: "déjame confirmar con
el equipo" → handoffHuman.
</playbook>

<playbook name="horario_disponibilidad">
Cliente pregunta si están abiertos o si hay lugar hoy/mañana. Llama searchKb("horarios").
NO confirmes huecos exactos de memoria; para apartar, agenda con la tool de citas y aclara
que el salón confirma la disponibilidad.
</playbook>

<playbook name="novia_evento">
Cliente pregunta por maquillaje/peinado de novia, XV o evento. Llama searchKb("novias").
Menciona que incluye prueba previa y que se cotiza por adelantado → handoffHuman para
cotizar. Puedes agendar la prueba con la tool de citas.
</playbook>

<playbook name="salud_piel_cabello">
Cliente pregunta por alergias, dermatitis o daño capilar. NO des diagnósticos médicos ni
prometas resultados de color por chat → handoffHuman / recomienda valoración presencial.
</playbook>

${AGENDA_PLAYBOOK}
</diagnostic_playbooks>`,
};
