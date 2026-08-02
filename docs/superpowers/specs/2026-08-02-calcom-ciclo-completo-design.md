# Cal.com — ciclo completo de citas (disponibilidad, agendar, reagendar, cancelar)

> Estado: aprobado, pendiente de implementación · 2026-08-02 (revisado)

## Problema

Forja Starter trae dos implementaciones de Cal.com que no se hablan entre sí:

1. **`src/integrations/calcom.ts`** — cliente contra la **API v2** de Cal.com,
   bien construido (`getAvailableSlots`, `createBooking`, resolución de
   `eventTypeId` por servicio, timezone configurable) y con test suite
   completa en `test/integrations/calcom.test.ts`. **Nadie lo usa.**
2. **`src/tools/scheduleAppointment.ts`** — la tool que sí está conectada al
   bot (`buildTools`, tier Pro). Llama directo a la **API v1**, con lógica
   duplicada e inconsistente: no resuelve `eventTypeId` por servicio, no usa
   timezone, y no checa disponibilidad antes de crear la cita.

Esto viene así desde el commit inicial de upstream (`santmun/forja`), no es
algo introducido por este fork. Además, el bot no tiene memoria de las citas
que agenda: una vez creada, no queda ningún registro que permita encontrarla
después para reagendarla o cancelarla.

Objetivo del pedido original ("agrega disponibilidad, agendar, reagendar y
cancelar") implica primero **resolver la inconsistencia v1/v2 de `agendar`**,
y luego construir las tres capacidades que de verdad faltan — con una
salvedad de negocio: reagendar y cancelar no deben ejecutarse solos contra el
calendario real; requieren una aprobación humana con un clic, sin fricción
para el cliente.

## Alcance

Dentro:
- Reescribir `scheduleAppointment` sobre la base v2 ya existente y probada.
- Tool nueva de disponibilidad (`checkAvailability`).
- Tool nueva de reagendado (`rescheduleAppointment`) — conversa con el
  cliente, valida el horario propuesto contra Cal.com, y genera una
  **solicitud de cambio pendiente de aprobación**, no un reagendado directo.
- Tool nueva de cancelación (`cancelAppointment`) — mismo mecanismo de
  solicitud pendiente, sin tocar Cal.com hasta que se apruebe.
- Memoria de citas en D1 (`appointments`) y de sus solicitudes de cambio
  (`appointment_change_requests`), para que el bot sepa qué cita tiene cada
  conversación y no se acepten dos cambios en paralelo sobre la misma cita.
- **Botón Aprobar/Rechazar en el panel `/admin`**, extendiendo la vista de
  Tickets que ya existe — sin construir una sección nueva del panel.
- Confirmación automática al cliente cuando el dueño aprueba un cambio,
  reusando el envío-como-humano que ya existe en la bandeja
  (`/admin/conversations/:id/reply`).
- Un reintento único y acotado (red o `5xx` de Cal.com) en las 4 llamadas de
  `integrations/calcom.ts`.

Fuera de este diseño (explícitamente pospuesto):
- Bookings con "seats" (eventos con cupo, ej. clases grupales) — el Starter
  de Forja no maneja ese caso hoy; se deja para cuando exista un niche pack
  que lo necesite.
- Un tope numérico de cuántas veces se puede reagendar la misma cita — se
  deja al criterio del dueño, con visibilidad completa del historial (ver
  Componente 2). Si en producción resulta necesario, se agrega después con
  datos reales de cuántos reagendados ocurren, no antes.
- Notificar al cliente automáticamente cuando se **rechaza** un cambio — solo
  se automatiza la confirmación al **aprobar**; el rechazo lo comunica el
  dueño manualmente desde la bandeja si lo considera necesario (decisión
  explícita, ver Decisión de negocio).

## Decisión de negocio: reagendar y cancelar requieren aprobación humana

En LIA (n8n), cancelar una cita estaba restringido a Victor o directivos —
nunca al agente conversacional directo con el cliente. Este diseño extiende
el mismo criterio a **reagendar**, con foco en que la experiencia del cliente
no sienta fricción:

- El bot **sí** conduce toda la conversación: deja que el cliente proponga
  libremente el nuevo horario (o pida cancelar), y valida contra Cal.com que
  ese horario esté realmente disponible — así el dueño nunca revisa una
  solicitud inválida.
- Lo único que el bot no hace por su cuenta es **ejecutar** el cambio en el
  calendario real. Arma el "registro completo" de la solicitud (nueva hora
  validada, o motivo de cancelación) y lo dispara a aprobación.
- La aprobación ocurre con **un clic** en el mismo panel donde el dueño ya
  revisa tickets — no una pantalla nueva que aprender.
- Al aprobar, el cliente recibe la confirmación **automáticamente**, por el
  mismo canal por el que escribió — el dueño no tiene que ir a avisarle.

Esto mantiene control humano sobre el calendario real sin que el cliente
perciba una demora de "ida y vuelta": desde su punto de vista, pidió un
cambio y en poco tiempo le llega la confirmación.

### Control de múltiples reagendamientos

Mientras una cita tiene una solicitud de cambio `pending`, el bot no acepta
una segunda sobre la misma cita — le dice al cliente que ya hay un cambio en
revisión. Esto se resuelve con un estado en la propia cita
(`appointments.status = 'change_pending'`), no con lógica adicional en las
tools.

Cada solicitud es una fila nueva en `appointment_change_requests` — nunca se
sobreescribe una anterior. El dueño puede ver, para cualquier cita, cuántas
veces se ha pedido moverla, cuándo, y qué se resolvió cada vez. Es
monitoreo completo sin imponer un límite arbitrario que no sabemos si hace
falta todavía.

## Enfoques considerados

- **A — Guardar el estado de la cita en D1 al crearla, con aprobación
  humana para cambios.** *(elegido)* Ver arquitectura abajo.
- **B — Buscar en vivo contra Cal.com por email/teléfono del asistente,
  reagendar/cancelar directo.** Sin tabla nueva, pero sin control humano
  sobre el calendario y dependiente de que el endpoint de listado de
  bookings de Cal.com filtre bien por attendee. Descartado: no cumple el
  requisito de aprobación.
- **C — Aprobación humana pero vía Cal.com mismo** (el dueño entra a su
  propio calendario de Cal.com a mover/cancelar la cita). Cero código nuevo
  de aprobación, pero obliga al dueño a salir de Forja y operar en dos
  sistemas — contradice el valor central del panel de Forja (todo en un
  lugar). Descartado.
- **D — Aprobación vía ticket genérico sin acción estructurada** (el ticket
  solo avisa "cliente quiere reagendar a X", el dueño reagenda a mano en
  Cal.com). Más simple de construir, pero no resuelve el pedido de "botón
  de aprobar" ni cierra el ciclo dentro de Forja. Descartado.

## Arquitectura

```
Cliente pregunta horario
  → checkAvailability          → integrations/calcom.ts:getAvailableSlots     (v2, ya existe)

Cliente confirma
  → scheduleAppointment        → integrations/calcom.ts:createBooking        (v2, ya existe)
                                → AppointmentsRepo.create()  (status='confirmed')

Cliente propone nuevo horario
  → rescheduleAppointment      → AppointmentsRepo.findActive(conversationId)
                                   · sin cita              → error no_appointment_found
                                   · status=change_pending → error change_already_pending
                                → integrations/calcom.ts:getAvailableSlots (valida el horario propuesto)
                                   · no disponible         → error slot_unavailable (bot ofrece alternativas)
                                → AppointmentChangeRequestsRepo.create(kind='reschedule', proposed_start)
                                → AppointmentsRepo.setChangePending()
                                → TicketsRepo.create() (ligado a la change request) + notifyOwner()

Cliente pide cancelar
  → cancelAppointment          → AppointmentsRepo.findActive(conversationId)  (mismos 2 checks de arriba)
                                → AppointmentChangeRequestsRepo.create(kind='cancel', reason)
                                → AppointmentsRepo.setChangePending()
                                → TicketsRepo.create() (ligado a la change request) + notifyOwner()

Dueño aprueba desde /admin/tickets (un clic)
  → POST /admin/tickets/:id/approve-change
       kind='reschedule'  → integrations/calcom.ts:rescheduleBooking (v2, NUEVA)
                           → AppointmentsRepo.confirmAfterReschedule(nuevo uid + start)
       kind='cancel'      → integrations/calcom.ts:cancelBooking     (v2, NUEVA)
                           → AppointmentsRepo.markCancelled()
                           → AppointmentChangeRequestsRepo.approve()
                           → TicketsRepo.resolve()
                           → sendChannelMessage() al cliente, mismo canal   (confirmación automática)

Dueño rechaza desde /admin/tickets
  → POST /admin/tickets/:id/reject-change
                           → AppointmentsRepo.revertToConfirmed()
                           → AppointmentChangeRequestsRepo.reject()
                           → TicketsRepo.resolve()
                           (sin auto-aviso al cliente — el dueño decide si le escribe)
```

Decisiones de diseño no obvias:

- **Todas las tools delegan la llamada HTTP a `integrations/calcom.ts`,
  nunca a `fetch` directo.** Es exactamente el problema que tiene hoy
  `scheduleAppointment.ts`.
- **`rescheduleBooking` y `cancelBooking` comparten `cal-api-version:
  2026-02-25`** con `createBooking` (mismo header de versión). Confirmado
  contra la documentación oficial de Cal.com v2 — no es una suposición.
- **La aprobación vive en la vista de Tickets, no en una sección nueva.**
  El panel ya tiene el patrón exacto que hace falta: una tarjeta por
  pendiente, con un form que hace POST y refresca. Construir una pantalla
  aparte duplicaría ese patrón sin necesidad.
- **La confirmación automática al cliente reusa la ruta de "responder como
  humano".** Hoy `/admin/conversations/:id/reply` ya resuelve el adapter del
  canal (`pickAdapter`), envía, persiste el mensaje y actualiza la
  conversación — se extrae esa secuencia a un helper (`sendChannelMessage`)
  para no duplicarla entre esa ruta y la nueva de aprobación.
- **`AppointmentsRepo.findActive` regresa la cita más reciente en estado
  `confirmed` o `change_pending`** (nunca `cancelled`), para poder distinguir
  "no tiene cita" de "ya tiene un cambio pendiente" con mensajes distintos.
- **El reintento vive una sola vez, en `integrations/calcom.ts`**, no en cada
  tool ni en cada ruta — así las 4 llamadas (slots, crear, reagendar,
  cancelar) lo heredan sin repetir código.

## Componentes

### 1. Migración — tablas `appointments` y `appointment_change_requests`,
columna nueva en `tickets`

En `src/db/schema.sql` (mismo patrón que `settings_history`: idempotente,
sin migración separada, se aplica con `pnpm db:apply:remote`):

```sql
CREATE TABLE IF NOT EXISTS appointments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT    NOT NULL,
  calcom_uid       TEXT    NOT NULL,
  event_type_id    INTEGER NOT NULL,
  start            TEXT    NOT NULL,   -- ISO datetime
  status           TEXT    NOT NULL,   -- 'confirmed' | 'change_pending' | 'cancelled'
  attendee_name    TEXT    NOT NULL,
  attendee_email   TEXT    NOT NULL,
  attendee_phone   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_conv
  ON appointments(conversation_id, status, start DESC);

CREATE TABLE IF NOT EXISTS appointment_change_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id   INTEGER NOT NULL,
  conversation_id  TEXT    NOT NULL,
  kind             TEXT    NOT NULL,   -- 'reschedule' | 'cancel'
  proposed_start   TEXT,               -- solo 'reschedule'
  reason           TEXT,
  status           TEXT    NOT NULL,   -- 'pending' | 'approved' | 'rejected'
  requested_at     INTEGER NOT NULL,
  resolved_at      INTEGER,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_change_requests_appt
  ON appointment_change_requests(appointment_id, status);

-- Liga un ticket a su solicitud de cambio, cuando aplica. NULL para todo
-- ticket "normal" (billing/product/complaint/other) que no viene de Cal.com.
ALTER TABLE tickets ADD COLUMN appointment_change_request_id INTEGER
  REFERENCES appointment_change_requests(id) ON DELETE SET NULL;
```

(La sentencia `ALTER TABLE` se ejecuta una sola vez por base — D1/SQLite no
soporta `ADD COLUMN IF NOT EXISTS`; se sigue el mismo criterio operativo que
ya usa el manual de Forja para cambios de esquema: correrla contra la base
ya existente de `birevx-support-bot` como parte del despliegue de esta
feature, documentada en el runbook igual que se hizo con `settings_history`.)

### 2. `integrations/calcom.ts` — `rescheduleBooking`, `cancelBooking`, reintento

```ts
export async function rescheduleBooking(
  env: Env,
  uid: string,
  newStart: string, // ISO
  reason?: string,
): Promise<
  | { ok: true; bookingId: number | string; uid: string; status?: string; start?: string }
  | { ok: false; reason: string }
>
```
`POST {CALCOM_API}/bookings/${uid}/reschedule`, header `cal-api-version:
2026-02-25` (constante `BOOKINGS_VERSION` reutilizada), body `{ start:
newStart, reschedulingReason: reason }`. Cal.com regresa un booking con uid
nuevo — ese es el que se guarda en D1.

```ts
export async function cancelBooking(
  env: Env,
  uid: string,
  reason?: string,
): Promise<{ ok: true } | { ok: false; reason: string }>
```
`POST {CALCOM_API}/bookings/${uid}/cancel`, mismo header de versión, body
`{ cancellationReason: reason }`.

**Reintento único:** se agrega un helper interno `fetchCalcom(url, init)` que
envuelve el `fetch` de las 4 funciones (`getAvailableSlots`, `createBooking`,
`rescheduleBooking`, `cancelBooking`). Reintenta **una sola vez**, con una
espera corta fija (~400ms, sin backoff exponencial), y solo cuando:
- el `fetch` lanzó una excepción (red/timeout), o
- la respuesta fue `5xx`.

Nunca reintenta un `4xx` — eso es un rechazo real de Cal.com (slot ocupado,
booking no reagendable, etc.), no una falla transitoria.

### 3. `db/appointments.ts` — `AppointmentsRepo`

```ts
export interface Appointment {
  id: number;
  conversation_id: string;
  calcom_uid: string;
  event_type_id: number;
  start: string;
  status: "confirmed" | "change_pending" | "cancelled";
  attendee_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  created_at: number;
  updated_at: number;
}

export class AppointmentsRepo {
  constructor(private readonly db: Db) {}
  async create(input: {
    conversationId: string;
    calcomUid: string;
    eventTypeId: number;
    start: string;
    attendeeName: string;
    attendeeEmail: string;
    attendeePhone?: string;
  }): Promise<number>;

  /** Cita más reciente en 'confirmed' o 'change_pending' (nunca 'cancelled'). */
  async findActive(conversationId: string): Promise<Appointment | null>;

  async setChangePending(id: number): Promise<void>;
  async revertToConfirmed(id: number): Promise<void>;
  async confirmAfterReschedule(id: number, newUid: string, newStart: string): Promise<void>;
  async markCancelled(id: number): Promise<void>;
}
```

### 4. `db/appointmentChangeRequests.ts` — `AppointmentChangeRequestsRepo` (nuevo)

```ts
export interface AppointmentChangeRequest {
  id: number;
  appointment_id: number;
  conversation_id: string;
  kind: "reschedule" | "cancel";
  proposed_start: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  requested_at: number;
  resolved_at: number | null;
}

export class AppointmentChangeRequestsRepo {
  constructor(private readonly db: Db) {}
  async create(input: {
    appointmentId: number;
    conversationId: string;
    kind: "reschedule" | "cancel";
    proposedStart?: string;
    reason?: string;
  }): Promise<number>;
  async getById(id: number): Promise<AppointmentChangeRequest | null>;
  async approve(id: number): Promise<void>;
  async reject(id: number): Promise<void>;
}
```

### 5. `tools/checkAvailability.ts` (nueva)

Sin cambios respecto al diseño original:
```
input:  { servicio?: string, fecha: string }   // YYYY-MM-DD
output: { ok: true, slots: string[] } | { ok: false, reason: string }
```

### 6. `tools/scheduleAppointment.ts` (reescrita in-place)

Sin cambios respecto al diseño original: resuelve `eventTypeId` + timezone →
`createBooking` (v2) → si `ok`, `AppointmentsRepo.create()` (`status:
'confirmed'`).

### 7. `tools/rescheduleAppointment.ts` (nueva)

```
input: { newStartTime: string, reason?: string }
```
1. `AppointmentsRepo.findActive(conversationId)`.
   - `null` → `{ error: "no_appointment_found" }`.
   - `status === "change_pending"` → `{ error: "change_already_pending" }`.
2. `getAvailableSlots` del día de `newStartTime`; si `newStartTime` no está
   en la lista → `{ error: "slot_unavailable", available: slots }` (el bot
   usa `available` para ofrecer alternativas reales en el mismo turno).
3. `AppointmentChangeRequestsRepo.create({ kind: "reschedule", proposedStart:
   newStartTime, reason })`, `AppointmentsRepo.setChangePending()`.
4. `TicketsRepo.create()` con `appointmentChangeRequestId` + `notifyOwner()`.
5. Regresa `{ ok: true, pending: true, proposedStart: newStartTime }`.

### 8. `tools/cancelAppointment.ts` (nueva)

```
input: { reason?: string }
```
Mismos checks 1 que `rescheduleAppointment`. Si hay cita activa:
`AppointmentChangeRequestsRepo.create({ kind: "cancel", reason })`,
`AppointmentsRepo.setChangePending()`, ticket + `notifyOwner()`. Regresa
`{ ok: true, pending: true }`.

### 9. `tools/index.ts`

Las 4 tools (`checkAvailability`, `scheduleAppointment`, `rescheduleAppointment`,
`cancelAppointment`) quedan bajo el mismo `if (isPro(ctx.env))` donde ya
vivía `scheduleAppointment` — sin cambio de tier.

### 10. `db/tickets.ts` — extender `TicketsRepo`

`CreateTicketInput` gana un campo opcional `appointmentChangeRequestId?:
number`, incluido en el `INSERT` cuando viene presente (columna nueva del
componente 1). El resto del repo no cambia.

### 11. `src/admin/conversationSend.ts` (nuevo, extraído de `routes.ts`)

```ts
export async function sendChannelMessage(
  env: Env,
  conversationId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }>
```
Encapsula exactamente lo que hoy hace inline `POST
/conversations/:id/reply`: buscar la conversación, `pickAdapter(...).
sendReply(...)`, `MessagesRepo.append(id, "owner", text)`,
`convs.touchLastMessage(id)`. La ruta de reply existente se refactoriza para
usar este helper (mismo comportamiento, sin duplicar código); la nueva ruta
de aprobación lo reutiliza para la confirmación automática.

### 12. `src/admin/views/tickets.ts` — Aprobar / Rechazar

Cuando un ticket trae `appointment_change_request_id`, la tarjeta muestra el
detalle de la solicitud (cita actual, nuevo horario propuesto o motivo de
cancelación) y dos botones — `Aprobar` / `Rechazar` — en vez del form
genérico de "Resolver". Los tickets sin solicitud ligada (billing, product,
complaint, other) se ven exactamente igual que hoy.

### 13. `src/admin/routes.ts` — rutas de aprobación

```
POST /admin/tickets/:id/approve-change
POST /admin/tickets/:id/reject-change
```

`approve-change`: carga el ticket → su `appointment_change_request` → su
`appointment`. Si `kind === "reschedule"`: `rescheduleBooking(uid,
proposed_start)` → `AppointmentsRepo.confirmAfterReschedule(...)`. Si
`kind === "cancel"`: `cancelBooking(uid, reason)` →
`AppointmentsRepo.markCancelled(...)`. En ambos casos:
`AppointmentChangeRequestsRepo.approve()`, `TicketsRepo.resolve()`, y
`sendChannelMessage()` con un mensaje de confirmación (texto distinto según
`kind`).

`reject-change`: `AppointmentsRepo.revertToConfirmed()`,
`AppointmentChangeRequestsRepo.reject()`, `TicketsRepo.resolve()`. Sin envío
al cliente (ver Decisión de negocio).

Si `rescheduleBooking`/`cancelBooking` fallan (Cal.com caído o rechaza), la
ruta no resuelve el ticket — se queda `pending` y la tarjeta muestra el
error, para que el dueño reintente el clic sin perder la solicitud.

## Manejo de errores

Mismo contrato que ya usa `integrations/calcom.ts`: `{ ok: true, ... } | {
ok: false, reason }`, nunca una excepción hacia la tool.

| Caso | `reason` / `error` |
|---|---|
| Sin `CALCOM_API_KEY` | `not_configured` |
| Cal.com responde no-2xx (tras el reintento) | `http_{status}` |
| Falla de red (tras el reintento) | `transient:{mensaje}` |
| No hay cita activa para la conversación | `no_appointment_found` |
| Ya hay una solicitud de cambio pendiente sobre esa cita | `change_already_pending` |
| El horario que propone el cliente ya no está libre | `slot_unavailable` (con la lista real de `available`) |
| El dueño aprueba pero Cal.com rechaza en ese momento | el ticket sigue `pending`, error visible en la tarjeta |

## Testing

- `test/integrations/calcom.test.ts` — casos nuevos para `rescheduleBooking`,
  `cancelBooking` y el reintento (`fetch` que lanza una vez y luego
  responde bien → éxito; `fetch` que siempre falla → `ok: false` tras un
  solo reintento, no más).
- `test/db/appointments.test.ts` y `test/db/appointmentChangeRequests.test.ts`
  (nuevos) — mismo patrón que los repos existentes contra D1 de test.
- `test/tools/checkAvailability.test.ts`, `scheduleAppointment.test.ts`
  (actualizado), `rescheduleAppointment.test.ts`, `cancelAppointment.test.ts`
  — incluyendo el caso `change_already_pending` y `slot_unavailable`.
- `test/admin/routes.test.ts` (extendido) — `approve-change` y
  `reject-change`, mismo estilo que las rutas existentes ahí (mock de
  `integrations/calcom.ts` y de `sendChannelMessage`).
- `pnpm test` + `pnpm typecheck` limpios antes de cada commit, como en las
  sesiones anteriores (YCloud, Instrucción Maestra).

## Fuera de alcance (explícito)

- Bookings con "seats" (cupo grupal).
- Tope numérico duro de reagendamientos por cita.
- Aviso automático al cliente cuando se **rechaza** un cambio.
- Sincronizar `appointments`/`appointment_change_requests` con ningún CRM
  externo — eso es el punto pendiente de la integración de CRM (ver
  `FORJA/_context/decisions.md`, 2026-08-01), fuera de este diseño.
