# Cal.com — ciclo completo de citas (disponibilidad, agendar, reagendar, cancelar)

> Estado: aprobado, pendiente de implementación · 2026-08-02

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
y luego construir las tres capacidades que de verdad faltan.

## Alcance

Dentro:
- Reescribir `scheduleAppointment` sobre la base v2 ya existente y probada.
- Tool nueva de disponibilidad (`checkAvailability`).
- Tool nueva de reagendado (`rescheduleAppointment`), llamando a Cal.com.
- Tool nueva de cancelación (`cancelAppointment`) — **sin tocar Cal.com**,
  solo escalando a un humano (ver Decisión de negocio abajo).
- Memoria de citas en D1 (`appointments`) para que reagendar/cancelar sepan
  a qué cita se refiere el cliente sin pedirle un código.

Fuera de este diseño (explícitamente pospuesto):
- Botón de cancelar desde el panel `/admin` — no se pidió, y cancelar sigue
  siendo una acción humana en Cal.com directamente o vía el ticket generado.
- Bookings con "seats" (eventos con cupo, ej. clases grupales) — el Starter
  de Forja no maneja ese caso hoy; se deja para cuando exista un niche pack
  que lo necesite.
- Reintentos automáticos si Cal.com está caído — mismo criterio que el resto
  del repo: se reporta el error, no se reintenta solo.

## Decisión de negocio: cancelar no es automático

En LIA (n8n), cancelar una cita estaba restringido a Victor o directivos —
nunca al agente conversacional directo con el cliente. Se mantiene el mismo
criterio aquí: `cancelAppointment` **no llama al endpoint de cancelación de
Cal.com**. Busca la cita en D1, crea un ticket (mismo mecanismo que
`handoffHuman`) con el detalle de la cita, notifica al dueño, y le dice al
bot que ya escaló — el cliente se entera de que su cancelación quedó
registrada y será confirmada por una persona, no que ya se canceló.

Reagendar sí es automático (sin esa restricción histórica en LIA): el cliente
puede mover su propia cita sin intervención humana.

## Enfoques considerados

- **A — Guardar el estado de la cita en D1 al crearla.** *(elegido)* Nueva
  tabla `appointments` ligada a `conversation_id`. El bot ya sabe qué cita
  tiene ese contacto sin preguntar nada. Costo: una tabla nueva + un repo.
- **B — Buscar en vivo contra Cal.com por email/teléfono del asistente.**
  Sin tabla nueva, pero depende de que el endpoint de listado de bookings de
  Cal.com filtre bien por attendee, y le añade una ronda de "dame tu correo
  otra vez" a cada reagendado/cancelación. Descartado por fricción y por
  acoplar el flujo a un endpoint que no se ha verificado a fondo.
- **C — Pedirle al cliente el `uid` de su cita** (viene en la confirmación
  de Cal.com por email). Cero estado nuevo, pero es fricción real en
  WhatsApp — nadie va a copiar un uid de un correo a un chat. Descartado.

## Arquitectura

```
Cliente pregunta horario
  → checkAvailability        → integrations/calcom.ts:getAvailableSlots   (v2, ya existe)

Cliente confirma
  → scheduleAppointment      → integrations/calcom.ts:createBooking       (v2, ya existe)
                              → AppointmentsRepo.create()  (D1, ligada a conversation_id)

Cliente pide otro horario
  → rescheduleAppointment    → AppointmentsRepo.findActive(conversationId)
                              → integrations/calcom.ts:rescheduleBooking  (v2, NUEVA)
                              → AppointmentsRepo.update()  (nuevo uid + nuevo start)

Cliente pide cancelar
  → cancelAppointment        → AppointmentsRepo.findActive(conversationId)
                              → TicketsRepo.create() + notifyOwner()      (reusa handoffHuman)
                              → AppointmentsRepo.markCancelRequested()
                              (Cal.com NO se toca — lo cancela un humano)
```

Decisiones de diseño no obvias:

- **Todas las tools delegan la llamada HTTP a `integrations/calcom.ts`,
  nunca a `fetch` directo.** Es exactamente el problema que tiene hoy
  `scheduleAppointment.ts` — duplicar la llamada a la API en la capa de tool
  es lo que la dejó en v1 mientras la v2 se construía al lado sin que nadie
  la conectara.
- **`rescheduleBooking` y `createBooking` comparten `cal-api-version:
  2026-02-25`.** Confirmado contra la documentación oficial de Cal.com v2
  (`POST /v2/bookings/{uid}/reschedule`, mismo header de versión que
  bookings) — no es una suposición.
- **`cancelAppointment` no necesita ninguna llamada a Cal.com.** Por la
  decisión de negocio de arriba, esta tool es puro D1 + ticket. Se
  contempló agregar `cancelBooking` a `integrations/calcom.ts` "por si
  luego se necesita" — se descarta: no hay caller hoy, y agregarlo sin uso
  es la misma clase de deuda que ya existe (código sin conectar).
- **`AppointmentsRepo.findActive` regresa la cita `confirmed` más reciente
  de la conversación**, no una lista. Un cliente con dos citas activas al
  mismo tiempo es un caso que no existe hoy en el negocio piloto de BIRevX;
  soportarlo sería construir para un caso hipotético (regla del proyecto:
  no diseñar para requisitos hipotéticos).

## Componentes

### 1. Migración — tabla `appointments`

En `src/db/schema.sql` (mismo patrón que `settings_history`: idempotente,
sin migración separada, se aplica con `pnpm db:apply:remote`):

```sql
CREATE TABLE IF NOT EXISTS appointments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT    NOT NULL,
  calcom_uid       TEXT    NOT NULL,
  event_type_id    INTEGER NOT NULL,
  start            TEXT    NOT NULL,   -- ISO datetime
  status           TEXT    NOT NULL,   -- 'confirmed' | 'cancel_requested'
  attendee_name    TEXT    NOT NULL,
  attendee_email   TEXT    NOT NULL,
  attendee_phone   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_conv
  ON appointments(conversation_id, status, start DESC);
```

### 2. `integrations/calcom.ts` — `rescheduleBooking`

Nueva función, mismo estilo que `createBooking`:

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

`POST {CALCOM_API}/bookings/${uid}/reschedule`, header
`cal-api-version: 2026-02-25` (constante `BOOKINGS_VERSION` ya existente,
reutilizada), body `{ start: newStart, reschedulingReason: reason }`. Cal.com
regresa un booking nuevo (uid distinto) — ese uid es el que se guarda en D1.

### 3. `db/appointments.ts` — `AppointmentsRepo`

Mismo patrón que `LeadsRepo`/`TicketsRepo`:

```ts
export interface Appointment {
  id: number;
  conversation_id: string;
  calcom_uid: string;
  event_type_id: number;
  start: string;
  status: "confirmed" | "cancel_requested";
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
  async findActive(conversationId: string): Promise<Appointment | null>; // status='confirmed', más reciente
  async updateAfterReschedule(id: number, newUid: string, newStart: string): Promise<void>;
  async markCancelRequested(id: number): Promise<void>;
}
```

### 4. `tools/checkAvailability.ts` (nueva)

```
input:  { servicio?: string, fecha: string }   // YYYY-MM-DD
output: { ok: true, slots: string[] } | { ok: false, reason: string }
```

Resuelve `eventTypeId` con `resolveEventTypeId` (ya existe) y timezone con
`calcomTimeZone` (ya existe). Llama `getAvailableSlots`.

### 5. `tools/scheduleAppointment.ts` (reescrita in-place)

Mismo nombre de tool (no rompe el system prompt ni las descripciones que ya
lo mencionan). Cambia la implementación interna:

```
input:  { servicio?, startTime, attendeeName, attendeeEmail, attendeePhone?, notes? }
```

Resuelve `eventTypeId` + timezone → `createBooking` (v2) → si `ok`,
`AppointmentsRepo.create()` con el `conversationId` del contexto de la tool
→ regresa `{ bookingId, uid, start }`.

### 6. `tools/rescheduleAppointment.ts` (nueva)

```
input: { newStartTime: string, reason?: string }
```

`AppointmentsRepo.findActive(conversationId)` → si no hay, `{ error:
"no_appointment_found" }` (el bot le dice al cliente que no tiene una cita
activa registrada y le ofrece agendar una). Si hay, `rescheduleBooking(uid,
newStartTime, reason)` → si `ok`, `updateAfterReschedule()`.

### 7. `tools/cancelAppointment.ts` (nueva)

```
input: { reason?: string }
```

`AppointmentsRepo.findActive(conversationId)` → si no hay, mismo error que
arriba. Si hay: `TicketsRepo.create()` (de `db/tickets.ts`) con categoría de agenda +
resumen que incluye fecha/hora de la cita, `ConversationsRepo.setOpenTicket()`
(de `db/conversations.ts`), `notifyOwner()` (importada de
`tools/handoffHuman.ts`, ya exportada ahí), `AppointmentsRepo.markCancelRequested()`
→ regresa `{ ticketId, escalated: true }`.

### 8. `tools/index.ts`

Las 4 tools (`checkAvailability`, `scheduleAppointment`, `rescheduleAppointment`,
`cancelAppointment`) quedan bajo el mismo `if (isPro(ctx.env))` donde ya
vivía `scheduleAppointment` — sin cambio de tier.

## Manejo de errores

Mismo contrato que ya usa `integrations/calcom.ts`: `{ ok: true, ... } | {
ok: false, reason }`, nunca una excepción hacia la tool.

| Caso | `reason` |
|---|---|
| Sin `CALCOM_API_KEY` | `not_configured` |
| Cal.com responde no-2xx | `http_{status}` |
| Falla de red | `transient:{mensaje}` |
| No hay cita activa para la conversación | `no_appointment_found` |
| Cal.com rechaza el reagendado (cita ya cancelada/rechazada) | `http_4xx` tal cual — la tool no reintenta, el bot le dice al cliente que agende una nueva |

## Testing

- `test/integrations/calcom.test.ts` — casos nuevos para `rescheduleBooking`,
  mismo estilo que los de `getAvailableSlots`/`createBooking` (mock de
  `fetch`, verificación de URL/header/body).
- `test/db/appointments.test.ts` (nuevo) — `AppointmentsRepo` contra D1 real
  de test (mismo patrón que `test/db/leads.test.ts` si existe, o Miniflare
  D1 en memoria).
- `test/tools/checkAvailability.test.ts`, `scheduleAppointment.test.ts`
  (actualizado), `rescheduleAppointment.test.ts`, `cancelAppointment.test.ts`
  — mockeando `integrations/calcom.ts` y `AppointmentsRepo`.
- `pnpm test` + `pnpm typecheck` limpios antes de cada commit, como en las
  sesiones anteriores (YCloud, Instrucción Maestra).

## Fuera de alcance (explícito)

- Botón de cancelar/reagendar desde el panel `/admin`.
- Bookings con "seats" (cupo grupal).
- Reintentos automáticos ante caída de Cal.com.
- Sincronizar `appointments` con ningún CRM externo — eso es el punto
  pendiente de la integración de CRM (ver `FORJA/_context/decisions.md`,
  2026-08-01), fuera de este diseño.
