import type { NichePack } from "./types";
import { AGENDA_PLAYBOOK } from "./agendaPlaybook";

// Nicho: Coach (vida, fitness, negocios, carrera). Vende sesiones 1:1, programas y
// mentorías. La venta casi nunca cierra en el chat: el objetivo del bot es CALIFICAR el
// lead y agendar la llamada de descubrimiento gratis. Enmarca el valor antes del precio,
// no promete resultados. Usa la tool de citas (servicio "Llamada de descubrimiento").
export const coach: NichePack = {
  id: "coach",
  recordSingular: "Sesión",
  recordPlural: "Sesiones",
  navLabel: "Sesiones",
  navIcon: "video",
  kpiLabel: "Sesiones",
  // solicitada → agendada → cliente(cerró) → no cerró
  statusLabels: {
    new: "Solicitada",
    contacted: "Agendada",
    sold: "Cliente",
    lost: "No cerró",
  },
  columns: [
    { key: "servicio", label: "Sesión" },
    { key: "fecha", label: "Fecha" },
    { key: "hora", label: "Hora" },
  ],
  defaultTone: "cercano, empático y motivador — enmarca el valor y dirige a la llamada de descubrimiento",
  kbDocs: ["precios", "metodologia", "modalidad", "testimonios", "politicas"],
  playbook: `<diagnostic_playbooks>
<playbook name="agendar_descubrimiento">
Cliente muestra interés ("me interesa", "cómo empiezo", "quiero info"). El objetivo
PRINCIPAL del bot es agendar la llamada de descubrimiento gratis. Pide: nombre, qué
quiere mejorar/lograr y su disponibilidad (día/franja). Con eso llama la tool de citas
(servicio "Llamada de descubrimiento"). Si no da fecha aún, captura el lead con
captureLead e indica que el coach lo contacta.
</playbook>

<playbook name="precio_planes">
Cliente pregunta precios. Llama searchKb("precios planes") y cita los planes, enmarcando
el valor antes del precio (qué incluye, resultado esperado). Si pregunta por el programa
largo y NO está en KB con precio: "se cotiza en la llamada de descubrimiento según tus
metas. ¿Agendamos?". NUNCA inventes descuentos.
</playbook>

<playbook name="me_sirve_a_mi">
Cliente describe su situación ("estoy estancado", "no bajo de peso", "quiero cambiar de
carrera") y pregunta si el coaching le sirve. NO diagnostiques ni prometas resultados
específicos. Valida el problema, explica brevemente cómo trabaja el coach
(searchKb("metodología")) y dirige SIEMPRE a la llamada de descubrimiento.
</playbook>

<playbook name="individual_vs_grupal">
Cliente no sabe si tomar 1:1 o grupal. Llama searchKb("planes modalidades"). Resume:
1:1 = personalizado, más caro; grupal = comunidad, más accesible. Recomienda según lo que
dijo necesitar y cierra ofreciendo la llamada de descubrimiento para definirlo juntos.
</playbook>

<playbook name="resultados_testimonios">
Cliente pregunta "¿funciona?" o "¿tienes casos de éxito?". Llama searchKb("testimonios")
y comparte 1-2 casos reales del KB. NO inventes testimonios ni garantices resultados. Si no
hay en KB: "el coach te comparte casos reales en la llamada de descubrimiento".
</playbook>

<playbook name="reagenda_cancelacion">
Cliente quiere mover o cancelar una sesión. Llama searchKb("políticas") y cita la política
(ej. avisar 24h antes, no-show pierde la sesión). Ayúdalo a reagendar con la tool de citas. Si
es caso especial (emergencia, reembolso, queja) → handoffHuman.
</playbook>

${AGENDA_PLAYBOOK}
</diagnostic_playbooks>`,
};
