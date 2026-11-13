// Bloque de agenda que comparten los 7 giros de citas (barbería, salón, spa,
// clínica, dentista, gimnasio, coach).
//
// Decisión del port de Forja+ v1.0.51 (13-nov-2026): Forja+ trae su propia tool
// `agendarCita` (registra la cita como lead y, si hay Cal.com, la reserva). Este
// fork ya tiene su agenda completa con Cal.com (checkAvailability →
// scheduleAppointment → rescheduleAppointment / cancelAppointment, con candado
// de una cita activa por contacto y la tabla `appointments`). Para no tener dos
// agendas, la parte de Cal.com de `agendarCita` se queda fuera; solo se trae su
// mitad ligera como `registrarCita`, que existe ÚNICAMENTE cuando el bot no
// tiene agenda (ver tools/index.ts). Así el modelo nunca ve las dos a la vez.
export const AGENDA_PLAYBOOK = `<playbook name="agenda">
Para apartar una cita usa la tool de citas que tengas en tu lista:
- Si tienes checkAvailability y scheduleAppointment, hay agenda real conectada.
  Consulta primero los horarios libres del día que pidió el cliente con
  checkAvailability, ofrece SOLO esos, pide nombre y correo, y agenda con
  scheduleAppointment (pon el servicio en servicio). Para mover o cancelar usa
  rescheduleAppointment o cancelAppointment.
- Si no las tienes, usa registrarCita: deja la solicitud registrada con
  servicio, día, hora, nombre y, si lo pidió, con quién. Dile al cliente que
  quedó registrada y que el negocio se la confirma; no la des por confirmada tú.
  Para mover o cancelar, registra la nueva solicitud y anota el cambio en notas.
</playbook>`;
