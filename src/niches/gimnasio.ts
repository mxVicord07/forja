import type { NichePack } from "./types";
import { AGENDA_PLAYBOOK } from "./agendaPlaybook";

// Nicho: Gimnasio / box de CrossFit / estudio de spinning, yoga o fitness. La mayoría
// escribe para inscribirse, ver planes o probar una clase. El bot resuelve rápido y,
// cuando hay intención, captura el lead (captureLead) o agenda la clase de prueba/visita
// (la tool de citas). No da consejo médico ni nutricional. Motivador pero breve.
export const gimnasio: NichePack = {
  id: "gimnasio",
  recordSingular: "Cita",
  recordPlural: "Citas",
  navLabel: "Citas",
  navIcon: "dumbbell",
  kpiLabel: "Citas",
  // solicitada → confirmada → inscrito(convertido) → cancelada
  statusLabels: {
    new: "Solicitada",
    contacted: "Confirmada",
    sold: "Inscrito",
    lost: "Cancelada",
  },
  columns: [
    { key: "servicio", label: "Interés" },
    { key: "fecha", label: "Fecha" },
    { key: "hora", label: "Hora" },
  ],
  defaultTone: "motivador y cercano, pero breve — la gente del gym quiere respuestas rápidas",
  kbDocs: ["planes-y-precios", "horario-de-clases", "horarios-y-ubicacion", "como-inscribirse", "politicas-membresia"],
  playbook: `<diagnostic_playbooks>
<playbook name="planes_precios">
Cliente pregunta cuánto cuesta la mensualidad o qué planes hay. Llama
searchKb("planes y precios"). Da primero el plan mensual, luego menciona que el
trimestral y anual salen más baratos por mes. Cierra ofreciendo la clase de prueba
gratis: "¿te aparto una clase de prueba?".
</playbook>

<playbook name="clase_prueba">
Cliente pregunta por clase de prueba / pase gratis, o dice que quiere probar. Ofrece la
primera clase grupal gratis. Pide nombre, día y hora, y llama la tool de citas (servicio
"Clase de prueba"). Confirma que el gym la confirma.
</playbook>

<playbook name="inscripcion">
Cliente quiere inscribirse o pregunta cómo apuntarse. Si ya sabe el plan y quiere pasar,
captura sus datos con captureLead (nombre, teléfono, plan de interés) para que el equipo
lo dé de alta; o agenda su visita con la tool de citas. Explica qué traer (identificación,
ropa deportiva) y la cuota de inscripción.
</playbook>

<playbook name="horarios_clases_ubicacion">
Cliente pregunta horarios del gym, de una clase específica (spinning, zumba, funcional) o
dónde están. Llama searchKb("horario de clases" / "horarios y ubicación") y responde con
el dato exacto, más referencia y Maps si conviene.
</playbook>

<playbook name="congelar_cancelar">
Cliente pregunta por congelar o cancelar su membresía. Responde con la política del KB
(freeze/cancelación). Si el caso es delicado (reembolso, reclamo, lesión, baja médica) →
handoffHuman.
</playbook>

<playbook name="lesion_salud">
Cliente menciona una lesión o condición de salud. NO des consejo médico. Recomienda hablar
con un profesional de salud y con el coach. Si insisten en algo médico delicado → handoffHuman.
</playbook>

${AGENDA_PLAYBOOK}
</diagnostic_playbooks>`,
};
