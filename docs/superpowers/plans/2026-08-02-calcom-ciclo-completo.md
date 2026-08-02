# Cal.com — ciclo completo de citas · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar al bot el ciclo completo de agenda sobre Cal.com API v2 — consultar disponibilidad, agendar, y solicitar reagendar/cancelar con aprobación humana de un clic desde el panel `/admin`.

**Architecture:** Las tools nunca llaman `fetch` directo: toda llamada HTTP a Cal.com vive en `src/integrations/calcom.ts` (v2, ya probado). Reagendar y cancelar no tocan el calendario — crean una fila en `appointment_change_requests` + un ticket ligado; el dueño aprueba/rechaza desde la vista de Tickets y ahí sí se ejecuta contra Cal.com y se le avisa al cliente automáticamente por su mismo canal.

**Tech Stack:** TypeScript · Cloudflare Workers (Hono) · D1 (SQLite) · Vercel AI SDK (`tool()` + zod) · Vitest + Miniflare

**Spec:** `docs/superpowers/specs/2026-08-02-calcom-ciclo-completo-design.md`

## Global Constraints

- **Cal.com API v2 únicamente.** `CALCOM_API = "https://api.cal.com/v2"`. La v1 que hoy usa `src/tools/scheduleAppointment.ts` se elimina en la Task 8.
- **Header de versión por endpoint:** `bookings`, `reschedule` y `cancel` usan `cal-api-version: 2026-02-25` (constante `BOOKINGS_VERSION`). `slots` usa `2024-09-04` (constante `SLOTS_VERSION`). Ya existen ambas en `calcom.ts` — reutilizarlas, no redefinirlas.
- **Contrato de retorno de `integrations/calcom.ts`:** siempre `{ ok: true, ... } | { ok: false, reason: string }`. Nunca lanza.
- **Tope de reagendamientos:** `MAX_RESCHEDULES = 3`, contando solo solicitudes con `status = 'approved'`.
- **Las 4 tools son tier Pro** — van dentro del `if (isPro(ctx.env))` que ya existe en `src/tools/index.ts`.
- **Comentarios y textos de cara al usuario en español**, igual que el resto del repo. Comentarios de código explican el *por qué*, no el *qué*.
- **Verificación por task:** `pnpm test` y `pnpm typecheck` deben quedar limpios antes de cada commit.
- **Nunca commitear secrets.** `CALCOM_API_KEY` es un secret de Cloudflare, ya configurado.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src/db/schema.sql` (M) | Tablas `appointments`, `appointment_change_requests`, columna nueva en `tickets` |
| `src/integrations/calcom.ts` (M) | Cliente HTTP v2: reintento + `rescheduleBooking` + `cancelBooking` |
| `src/db/appointments.ts` (C) | `AppointmentsRepo` — estado de la cita |
| `src/db/appointmentChangeRequests.ts` (C) | `AppointmentChangeRequestsRepo` — solicitudes y su conteo |
| `src/db/tickets.ts` (M) | Campo opcional para ligar un ticket a una solicitud |
| `src/tools/checkAvailability.ts` (C) | Tool: horarios libres |
| `src/tools/scheduleAppointment.ts` (M) | Tool reescrita sobre v2 + persistencia en D1 |
| `src/tools/rescheduleAppointment.ts` (C) | Tool: solicitud de reagendado (con tope de 3) |
| `src/tools/cancelAppointment.ts` (C) | Tool: solicitud de cancelación |
| `src/tools/index.ts` (M) | Registro de las 4 tools en tier Pro |
| `src/admin/conversationSend.ts` (C) | Helper compartido: enviar al cliente por su canal |
| `src/admin/views/tickets.ts` (M) | Tarjeta con Aprobar / Rechazar |
| `src/admin/routes.ts` (M) | Rutas `approve-change` / `reject-change`; refactor del reply |
| `docs/canales/calcom.md` (C) | Runbook de despliegue (incluye el `ALTER TABLE`) |

---

### Task 1: Esquema de base de datos

**Files:**
- Modify: `src/db/schema.sql` (append al final)

**Interfaces:**
- Consumes: nada (primera task)
- Produces: tablas `appointments` y `appointment_change_requests`; columna `tickets.appointment_change_request_id`

- [ ] **Step 1: Agregar las tablas al final de `src/db/schema.sql`**

```sql

-- Citas agendadas vía Cal.com. Es la memoria que permite reagendar/cancelar
-- después: sin esta tabla el bot crea la cita y la olvida, y no habría forma
-- de saber a qué booking se refiere el cliente cuando vuelve a escribir.
-- status: 'confirmed' | 'change_pending' | 'cancelled'
CREATE TABLE IF NOT EXISTS appointments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT    NOT NULL,
  calcom_uid       TEXT    NOT NULL,
  event_type_id    INTEGER NOT NULL,
  start            TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  attendee_name    TEXT    NOT NULL,
  attendee_email   TEXT    NOT NULL,
  attendee_phone   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_conv
  ON appointments(conversation_id, status, start DESC);

-- Solicitudes de cambio pendientes de aprobación humana. Cada intento es una
-- fila nueva (nunca se sobreescribe una anterior): así el dueño ve el historial
-- completo de cuántas veces se pidió mover cada cita, y el conteo de las
-- 'approved' alimenta el tope de 3 reagendamientos.
-- kind: 'reschedule' | 'cancel' · status: 'pending' | 'approved' | 'rejected'
CREATE TABLE IF NOT EXISTS appointment_change_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id   INTEGER NOT NULL,
  conversation_id  TEXT    NOT NULL,
  kind             TEXT    NOT NULL,
  proposed_start   TEXT,
  reason           TEXT,
  status           TEXT    NOT NULL,
  requested_at     INTEGER NOT NULL,
  resolved_at      INTEGER,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_change_requests_appt
  ON appointment_change_requests(appointment_id, status);
```

- [ ] **Step 2: Agregar la columna a `tickets`**

En el mismo archivo, localizar el bloque `CREATE TABLE IF NOT EXISTS tickets (...)` (alrededor de la línea 55) y agregar la columna **dentro** del `CREATE TABLE`, justo después de `resolved_by TEXT,`:

```sql
  -- Liga el ticket a su solicitud de cambio de cita, cuando aplica. NULL para
  -- todo ticket "normal" (billing/product/complaint/other) que no viene de Cal.com.
  appointment_change_request_id INTEGER,
```

Ponerla dentro del `CREATE TABLE` (y no como `ALTER TABLE`) hace que una base nueva quede correcta de un solo golpe. Para la base **ya existente** de producción hace falta el `ALTER TABLE` — eso va documentado en el runbook de la Task 14, no en este archivo.

- [ ] **Step 3: Verificar que el esquema carga en Miniflare**

Run: `pnpm test test/db/tickets.test.ts`
Expected: PASS. `createTestMiniflare()` aplica `schema.sql` completo statement por statement; si alguna sentencia nueva tuviera un error de sintaxis, estos tests fallarían al arrancar.

- [ ] **Step 4: Verificar typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat(db): tablas appointments y appointment_change_requests"
```

---

### Task 2: Cliente Cal.com — reintento, rescheduleBooking, cancelBooking

**Files:**
- Modify: `src/integrations/calcom.ts`
- Test: `test/integrations/calcom.test.ts`

**Interfaces:**
- Consumes: `Env`, constantes `CALCOM_API`, `BOOKINGS_VERSION`, `SLOTS_VERSION` (ya existen en el archivo)
- Produces:
  - `rescheduleBooking(env, uid: string, newStart: string, reason?: string): Promise<{ ok: true; bookingId: number | string; uid: string; status?: string; start?: string } | { ok: false; reason: string }>`
  - `cancelBooking(env, uid: string, reason?: string): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `test/integrations/calcom.test.ts` (y añadir `rescheduleBooking, cancelBooking` al `import` del principio del archivo):

```ts
describe("rescheduleBooking", () => {
  it("hace POST al endpoint de reschedule con la versión correcta", async () => {
    const fetchMock = vi.fn(async (_url: any, _init: any) =>
      new Response(
        JSON.stringify({ status: "success", data: { id: 777, uid: "nuevo-uid", status: "accepted", start: "2026-07-25T16:00:00Z" } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await rescheduleBooking(env({ CALCOM_API_KEY: "cal_x" }), "viejo-uid", "2026-07-25T16:00:00Z", "cliente pidió otro día");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.uid).toBe("nuevo-uid");
      expect(res.bookingId).toBe(777);
    }

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v2/bookings/viejo-uid/reschedule");
    expect((init as any).method).toBe("POST");
    expect((init as any).headers["cal-api-version"]).toBe("2026-02-25");
    const body = JSON.parse((init as any).body);
    expect(body.start).toBe("2026-07-25T16:00:00Z");
    expect(body.reschedulingReason).toBe("cliente pidió otro día");
  });

  it("no llama a la API sin key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await rescheduleBooking(env(), "uid", "2026-07-25T16:00:00Z");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cancelBooking", () => {
  it("hace POST al endpoint de cancel con el motivo", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "success" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await cancelBooking(env({ CALCOM_API_KEY: "cal_x" }), "uid-1", "el cliente ya no puede");
    expect(res.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v2/bookings/uid-1/cancel");
    expect((init as any).headers["cal-api-version"]).toBe("2026-02-25");
    expect(JSON.parse((init as any).body).cancellationReason).toBe("el cliente ya no puede");
  });

  it("error http → ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    const res = await cancelBooking(env({ CALCOM_API_KEY: "cal_x" }), "uid-1");
    expect(res.ok).toBe(false);
  });
});

describe("reintento único", () => {
  it("reintenta una vez si el fetch lanza, y tiene éxito en el segundo intento", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await cancelBooking(env({ CALCOM_API_KEY: "cal_x" }), "uid-1");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reintenta una vez ante 5xx y luego se rinde (2 llamadas, no más)", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await cancelBooking(env({ CALCOM_API_KEY: "cal_x" }), "uid-1");
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("NO reintenta ante 4xx — es un rechazo real, no una falla transitoria", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await cancelBooking(env({ CALCOM_API_KEY: "cal_x" }), "uid-1");
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `pnpm test test/integrations/calcom.test.ts`
Expected: FAIL — `rescheduleBooking is not a function` / `cancelBooking is not a function`.

- [ ] **Step 3: Implementar el helper de reintento**

Agregar en `src/integrations/calcom.ts`, después de las constantes de versión:

```ts
/** Espera entre el intento fallido y el reintento. Fija, sin backoff exponencial. */
const RETRY_DELAY_MS = 400;

/**
 * `fetch` con UN solo reintento, compartido por las 4 llamadas a Cal.com.
 *
 * Reintenta solo lo que de verdad es transitorio: una excepción de red o un
 * 5xx del servidor. Un 4xx NO se reintenta — es un rechazo real (slot ocupado,
 * booking ya cancelado) y repetirlo daría el mismo resultado, más lento.
 *
 * Devuelve la Response o lanza; cada caller traduce eso a su `{ ok: false }`.
 */
async function fetchCalcom(url: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (res.status < 500) return res;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await fetch(url, init);
  } catch (e) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await fetch(url, init);
  }
}
```

- [ ] **Step 4: Enrutar las dos funciones existentes por el helper**

En `getAvailableSlots` y `createBooking`, sustituir la llamada `await fetch(...)` por `await fetchCalcom(...)`. Los argumentos no cambian — solo el nombre de la función. Ejemplo en `getAvailableSlots`:

```ts
    const res = await fetchCalcom(url, {
      headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": SLOTS_VERSION },
    });
```

- [ ] **Step 5: Implementar `rescheduleBooking` y `cancelBooking`**

Agregar al final de `src/integrations/calcom.ts`, antes del helper `nextDay`:

```ts
/**
 * Mueve una cita existente a otro horario. Cal.com devuelve un booking NUEVO
 * con uid distinto — ese uid es el que hay que guardar, el viejo deja de servir.
 */
export async function rescheduleBooking(
  env: Env,
  uid: string,
  newStart: string,
  reason?: string,
): Promise<
  | { ok: true; bookingId: number | string; uid: string; status?: string; start?: string }
  | { ok: false; reason: string }
> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetchCalcom(`${CALCOM_API}/bookings/${encodeURIComponent(uid)}/reschedule`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CALCOM_API_KEY}`,
        "cal-api-version": BOOKINGS_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ start: newStart, ...(reason ? { reschedulingReason: reason } : {}) }),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.json()) as {
      data?: { id: number | string; uid?: string; status?: string; start?: string };
    };
    const d = body.data;
    if (!d?.id || !d.uid) return { ok: false, reason: "no_booking_id" };
    return { ok: true, bookingId: d.id, uid: d.uid, status: d.status, start: d.start };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/**
 * Cancela una cita. Solo la llama la ruta de aprobación del panel — el bot
 * nunca cancela por su cuenta (ver la decisión de negocio en el spec).
 */
export async function cancelBooking(
  env: Env,
  uid: string,
  reason?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetchCalcom(`${CALCOM_API}/bookings/${encodeURIComponent(uid)}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CALCOM_API_KEY}`,
        "cal-api-version": BOOKINGS_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reason ? { cancellationReason: reason } : {}),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}
```

- [ ] **Step 6: Correr los tests**

Run: `pnpm test test/integrations/calcom.test.ts`
Expected: PASS — todos, incluidos los preexistentes de `getAvailableSlots`/`createBooking` (que ahora pasan por `fetchCalcom`).

- [ ] **Step 7: Typecheck y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores, sin regresiones.

- [ ] **Step 8: Commit**

```bash
git add src/integrations/calcom.ts test/integrations/calcom.test.ts
git commit -m "feat(calcom): rescheduleBooking, cancelBooking y reintento único"
```

---

### Task 3: AppointmentsRepo

**Files:**
- Create: `src/db/appointments.ts`
- Test: `test/db/appointments.test.ts`

**Interfaces:**
- Consumes: `Db` de `src/db/client.ts`; tabla `appointments` (Task 1)
- Produces: `interface Appointment`, `class AppointmentsRepo` con `create`, `findActive`, `setChangePending`, `revertToConfirmed`, `confirmAfterReschedule`, `markCancelled`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/db/appointments.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";

let repo: AppointmentsRepo;

const base = {
  conversationId: "telegram:1",
  calcomUid: "uid-1",
  eventTypeId: 10,
  start: "2026-07-20T15:00:00Z",
  attendeeName: "Ana",
  attendeeEmail: "ana@example.com",
};

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  repo = new AppointmentsRepo(new Db(d1 as any));
});

describe("AppointmentsRepo", () => {
  it("create deja la cita en 'confirmed' y findActive la encuentra", async () => {
    await repo.create(base);
    const appt = await repo.findActive("telegram:1");
    expect(appt?.status).toBe("confirmed");
    expect(appt?.calcom_uid).toBe("uid-1");
    expect(appt?.attendee_phone).toBeNull();
  });

  it("findActive devuelve null si la conversación no tiene citas", async () => {
    expect(await repo.findActive("telegram:999")).toBeNull();
  });

  it("setChangePending marca la cita y findActive la sigue devolviendo", async () => {
    const id = await repo.create(base);
    await repo.setChangePending(id);
    const appt = await repo.findActive("telegram:1");
    expect(appt?.status).toBe("change_pending");
  });

  it("revertToConfirmed regresa la cita a 'confirmed'", async () => {
    const id = await repo.create(base);
    await repo.setChangePending(id);
    await repo.revertToConfirmed(id);
    expect((await repo.findActive("telegram:1"))?.status).toBe("confirmed");
  });

  it("confirmAfterReschedule cambia uid, start y vuelve a 'confirmed'", async () => {
    const id = await repo.create(base);
    await repo.setChangePending(id);
    await repo.confirmAfterReschedule(id, "uid-2", "2026-07-25T16:00:00Z");
    const appt = await repo.findActive("telegram:1");
    expect(appt?.calcom_uid).toBe("uid-2");
    expect(appt?.start).toBe("2026-07-25T16:00:00Z");
    expect(appt?.status).toBe("confirmed");
  });

  it("markCancelled saca la cita de findActive", async () => {
    const id = await repo.create(base);
    await repo.markCancelled(id);
    expect(await repo.findActive("telegram:1")).toBeNull();
  });

  it("findActive devuelve la más reciente por start cuando hay varias", async () => {
    await repo.create({ ...base, calcomUid: "vieja", start: "2026-07-01T10:00:00Z" });
    await repo.create({ ...base, calcomUid: "nueva", start: "2026-08-01T10:00:00Z" });
    expect((await repo.findActive("telegram:1"))?.calcom_uid).toBe("nueva");
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/db/appointments.test.ts`
Expected: FAIL — no se puede resolver `../../src/db/appointments`.

- [ ] **Step 3: Implementar el repo**

Crear `src/db/appointments.ts`:

```ts
import { Db } from "./client";

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

export interface CreateAppointmentInput {
  conversationId: string;
  calcomUid: string;
  eventTypeId: number;
  start: string;
  attendeeName: string;
  attendeeEmail: string;
  attendeePhone?: string;
}

export class AppointmentsRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateAppointmentInput): Promise<number> {
    const now = Date.now();
    // RETURNING id en vez de meta.last_row_id: es explícito y no depende de
    // cómo tipe D1 los metadatos del INSERT.
    const row = await this.db.first<{ id: number }>(
      `INSERT INTO appointments
         (conversation_id, calcom_uid, event_type_id, start, status,
          attendee_name, attendee_email, attendee_phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        input.conversationId,
        input.calcomUid,
        input.eventTypeId,
        input.start,
        input.attendeeName,
        input.attendeeEmail,
        input.attendeePhone ?? null,
        now,
        now,
      ],
    );
    if (!row) throw new Error("appointments insert no devolvió id");
    return row.id;
  }

  /**
   * Cita vigente de una conversación: la más próxima en el futuro primero, y
   * nunca una ya cancelada. Incluye 'change_pending' a propósito — las tools
   * necesitan distinguir "no tiene cita" de "ya tiene un cambio en revisión".
   */
  async findActive(conversationId: string): Promise<Appointment | null> {
    return this.db.first<Appointment>(
      `SELECT * FROM appointments
       WHERE conversation_id = ? AND status IN ('confirmed', 'change_pending')
       ORDER BY start DESC LIMIT 1`,
      [conversationId],
    );
  }

  async setChangePending(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointments SET status = 'change_pending', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  async revertToConfirmed(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointments SET status = 'confirmed', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  /** Tras un reagendado aprobado: Cal.com dio un uid nuevo, el viejo ya no sirve. */
  async confirmAfterReschedule(id: number, newUid: string, newStart: string): Promise<void> {
    await this.db.run(
      `UPDATE appointments
       SET calcom_uid = ?, start = ?, status = 'confirmed', updated_at = ?
       WHERE id = ?`,
      [newUid, newStart, Date.now(), id],
    );
  }

  async markCancelled(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }
}
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/db/appointments.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/db/appointments.ts test/db/appointments.test.ts
git commit -m "feat(db): AppointmentsRepo"
```

---

### Task 4: AppointmentChangeRequestsRepo

**Files:**
- Create: `src/db/appointmentChangeRequests.ts`
- Test: `test/db/appointmentChangeRequests.test.ts`

**Interfaces:**
- Consumes: `Db`; tabla `appointment_change_requests` (Task 1); `AppointmentsRepo.create` (Task 3) para armar el fixture
- Produces: `interface AppointmentChangeRequest`, `class AppointmentChangeRequestsRepo` con `create`, `getById`, `approve`, `reject`, `countApproved`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/db/appointmentChangeRequests.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";
import { AppointmentChangeRequestsRepo } from "../../src/db/appointmentChangeRequests";

let repo: AppointmentChangeRequestsRepo;
let apptId: number;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  // La tabla tiene FK a appointments(id): hace falta una cita real primero.
  apptId = await new AppointmentsRepo(db).create({
    conversationId: "telegram:1",
    calcomUid: "uid-1",
    eventTypeId: 10,
    start: "2026-07-20T15:00:00Z",
    attendeeName: "Ana",
    attendeeEmail: "ana@example.com",
  });
  repo = new AppointmentChangeRequestsRepo(db);
});

const reschedule = () => ({
  appointmentId: apptId,
  conversationId: "telegram:1",
  kind: "reschedule" as const,
  proposedStart: "2026-07-25T16:00:00Z",
});

describe("AppointmentChangeRequestsRepo", () => {
  it("create deja la solicitud en 'pending'", async () => {
    const id = await repo.create(reschedule());
    const cr = await repo.getById(id);
    expect(cr?.status).toBe("pending");
    expect(cr?.kind).toBe("reschedule");
    expect(cr?.proposed_start).toBe("2026-07-25T16:00:00Z");
    expect(cr?.resolved_at).toBeNull();
  });

  it("create de tipo cancel no lleva proposed_start", async () => {
    const id = await repo.create({
      appointmentId: apptId,
      conversationId: "telegram:1",
      kind: "cancel",
      reason: "ya no puedo",
    });
    const cr = await repo.getById(id);
    expect(cr?.kind).toBe("cancel");
    expect(cr?.proposed_start).toBeNull();
    expect(cr?.reason).toBe("ya no puedo");
  });

  it("approve marca status y resolved_at", async () => {
    const id = await repo.create(reschedule());
    await repo.approve(id);
    const cr = await repo.getById(id);
    expect(cr?.status).toBe("approved");
    expect(cr?.resolved_at).toBeTruthy();
  });

  it("reject marca status y resolved_at", async () => {
    const id = await repo.create(reschedule());
    await repo.reject(id);
    const cr = await repo.getById(id);
    expect(cr?.status).toBe("rejected");
    expect(cr?.resolved_at).toBeTruthy();
  });

  it("countApproved cuenta solo las aprobadas de ese tipo", async () => {
    const a = await repo.create(reschedule());
    const b = await repo.create(reschedule());
    const c = await repo.create(reschedule());
    await repo.approve(a);
    await repo.approve(b);
    await repo.reject(c); // rechazada: no cuenta, nada se movió de verdad
    await repo.approve(
      await repo.create({ appointmentId: apptId, conversationId: "telegram:1", kind: "cancel" }),
    );

    expect(await repo.countApproved(apptId, "reschedule")).toBe(2);
    expect(await repo.countApproved(apptId, "cancel")).toBe(1);
  });

  it("countApproved es 0 para una cita sin solicitudes", async () => {
    expect(await repo.countApproved(apptId, "reschedule")).toBe(0);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/db/appointmentChangeRequests.test.ts`
Expected: FAIL — no se puede resolver el módulo.

- [ ] **Step 3: Implementar el repo**

Crear `src/db/appointmentChangeRequests.ts`:

```ts
import { Db } from "./client";

export type ChangeKind = "reschedule" | "cancel";

export interface AppointmentChangeRequest {
  id: number;
  appointment_id: number;
  conversation_id: string;
  kind: ChangeKind;
  proposed_start: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  requested_at: number;
  resolved_at: number | null;
}

export interface CreateChangeRequestInput {
  appointmentId: number;
  conversationId: string;
  kind: ChangeKind;
  proposedStart?: string;
  reason?: string;
}

export class AppointmentChangeRequestsRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateChangeRequestInput): Promise<number> {
    const row = await this.db.first<{ id: number }>(
      `INSERT INTO appointment_change_requests
         (appointment_id, conversation_id, kind, proposed_start, reason, status, requested_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)
       RETURNING id`,
      [
        input.appointmentId,
        input.conversationId,
        input.kind,
        input.proposedStart ?? null,
        input.reason ?? null,
        Date.now(),
      ],
    );
    if (!row) throw new Error("appointment_change_requests insert no devolvió id");
    return row.id;
  }

  async getById(id: number): Promise<AppointmentChangeRequest | null> {
    return this.db.first<AppointmentChangeRequest>(
      "SELECT * FROM appointment_change_requests WHERE id = ?",
      [id],
    );
  }

  async approve(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointment_change_requests SET status = 'approved', resolved_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  async reject(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointment_change_requests SET status = 'rejected', resolved_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  /**
   * Cuántos cambios de este tipo YA se ejecutaron sobre la cita. Alimenta el
   * tope de 3 reagendamientos: solo cuentan los aprobados, porque un rechazo
   * significa que la cita nunca se movió.
   */
  async countApproved(appointmentId: number, kind: ChangeKind): Promise<number> {
    const row = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) as n FROM appointment_change_requests
       WHERE appointment_id = ? AND kind = ? AND status = 'approved'`,
      [appointmentId, kind],
    );
    return row?.n ?? 0;
  }
}
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/db/appointmentChangeRequests.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/db/appointmentChangeRequests.ts test/db/appointmentChangeRequests.test.ts
git commit -m "feat(db): AppointmentChangeRequestsRepo con countApproved"
```

---

### Task 5: Ligar tickets a solicitudes de cambio

**Files:**
- Modify: `src/db/tickets.ts`
- Test: `test/db/tickets.test.ts`

**Interfaces:**
- Consumes: columna `tickets.appointment_change_request_id` (Task 1)
- Produces: `Ticket.appointment_change_request_id: number | null`; `CreateTicketInput.appointmentChangeRequestId?: number`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `test/db/tickets.test.ts`, dentro del `describe("TicketsRepo")`:

```ts
  it("guarda el id de la solicitud de cambio cuando se pasa", async () => {
    const id = await repo.create({
      conversationId: null,
      category: "agenda",
      summary: "Reagendar cita",
      transcript: "",
      appointmentChangeRequestId: 42,
    });
    expect((await repo.getById(id))?.appointment_change_request_id).toBe(42);
  });

  it("deja el id en null para un ticket normal", async () => {
    const id = await repo.create({
      conversationId: null,
      category: "product",
      summary: "x",
      transcript: "",
    });
    expect((await repo.getById(id))?.appointment_change_request_id).toBeNull();
  });
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/db/tickets.test.ts`
Expected: FAIL — error de tipo en `appointmentChangeRequestId` y/o el valor llega `undefined`.

- [ ] **Step 3: Extender el repo**

En `src/db/tickets.ts`, agregar el campo a las dos interfaces y al `INSERT`:

```ts
export interface Ticket {
  id: string;
  conversation_id: string | null;
  category: string;
  summary: string;
  transcript: string;
  status: "open" | "in_progress" | "resolved";
  resolved_at: number | null;
  resolved_by: string | null;
  /** Solicitud de cambio de cita ligada, o null para un ticket normal. */
  appointment_change_request_id: number | null;
  created_at: number;
}

export interface CreateTicketInput {
  conversationId: string | null;
  category: string;
  summary: string;
  transcript: string;
  appointmentChangeRequestId?: number;
}
```

Y en `create`:

```ts
  async create(input: CreateTicketInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO tickets
         (id, conversation_id, category, summary, transcript, appointment_change_request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.category,
        input.summary,
        input.transcript,
        input.appointmentChangeRequestId ?? null,
        Date.now(),
      ],
    );
    return id;
  }
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/db/tickets.test.ts`
Expected: PASS (5 tests: los 3 previos + los 2 nuevos).

- [ ] **Step 5: Typecheck y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores. `listOpen` usa `SELECT *`, así que ya trae la columna nueva sin cambios.

- [ ] **Step 6: Commit**

```bash
git add src/db/tickets.ts test/db/tickets.test.ts
git commit -m "feat(db): ligar tickets a solicitudes de cambio de cita"
```

---

### Task 6: Tool checkAvailability

**Files:**
- Create: `src/tools/checkAvailability.ts`
- Test: `test/tools/checkAvailability.test.ts`

**Interfaces:**
- Consumes: `getAvailableSlots`, `resolveEventTypeId`, `calcomTimeZone` de `src/integrations/calcom.ts`
- Produces: `checkAvailabilityTool(env: Env): Tool` — resultado `{ ok: true; slots: string[] } | { error: string }`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/tools/checkAvailability.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkAvailabilityTool } from "../../src/tools/checkAvailability";

afterEach(() => vi.restoreAllMocks());

const env = (over: any = {}) => ({ CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPE_ID: "10", ...over }) as any;

describe("checkAvailabilityTool", () => {
  it("devuelve los horarios libres del día", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { "2026-07-20": [{ start: "2026-07-20T09:00:00Z" }, { start: "2026-07-20T10:00:00Z" }] } }),
          { status: 200 },
        ),
      ),
    );
    const tool = checkAvailabilityTool(env());
    const res = (await tool.execute!({ fecha: "2026-07-20" }, {} as any)) as any;
    expect(res.ok).toBe(true);
    expect(res.slots).toEqual(["2026-07-20T09:00:00Z", "2026-07-20T10:00:00Z"]);
  });

  it("error si Cal.com no está configurado", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = checkAvailabilityTool({} as any);
    const res = (await tool.execute!({ fecha: "2026-07-20" }, {} as any)) as any;
    expect(res.error).toBe("calcom_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resuelve el eventTypeId por servicio cuando hay mapa", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = checkAvailabilityTool(env({ CALCOM_EVENT_TYPES: '{"corte":10,"barba":20}' }));
    await tool.execute!({ fecha: "2026-07-20", servicio: "quiero barba" }, {} as any);
    expect(String(fetchMock.mock.calls[0][0])).toContain("eventTypeId=20");
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/tools/checkAvailability.test.ts`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implementar la tool**

Crear `src/tools/checkAvailability.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import {
  calcomConfigured,
  calcomTimeZone,
  getAvailableSlots,
  resolveEventTypeId,
} from "../integrations/calcom";

export function checkAvailabilityTool(env: Env) {
  return tool({
    description:
      "Consulta los horarios libres de un día para agendar. Úsala ANTES de agendar o de aceptar un cambio de horario, para no ofrecer un espacio que ya está ocupado.",
    inputSchema: z.object({
      fecha: z.string().describe("Día a consultar en formato YYYY-MM-DD"),
      servicio: z.string().optional().describe("Servicio que pide el cliente, si lo mencionó"),
    }),
    execute: async ({ fecha, servicio }) => {
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };
      const eventTypeId = resolveEventTypeId(env, servicio);
      if (eventTypeId === null) return { error: "calcom_not_configured" as const };

      const res = await getAvailableSlots(env, eventTypeId, fecha, calcomTimeZone(env));
      if (!res.ok) return { error: res.reason };
      return { ok: true as const, slots: res.slots };
    },
  });
}
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/tools/checkAvailability.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/tools/checkAvailability.ts test/tools/checkAvailability.test.ts
git commit -m "feat(tools): checkAvailability sobre Cal.com v2"
```

---

### Task 7: Reescribir scheduleAppointment sobre v2

**Files:**
- Modify: `src/tools/scheduleAppointment.ts` (reemplazo completo del archivo)
- Test: `test/tools/scheduleAppointment.test.ts` (reemplazo completo del archivo)

**Interfaces:**
- Consumes: `createBooking`, `resolveEventTypeId`, `calcomTimeZone`, `calcomConfigured` (calcom.ts); `AppointmentsRepo` (Task 3)
- Produces: `scheduleAppointmentTool(env: Env, getConversationId: () => string | null): Tool` — resultado `{ ok: true; bookingId; uid; start } | { error: string }`

- [ ] **Step 1: Reemplazar el test por completo**

Sobrescribir `test/tools/scheduleAppointment.test.ts`. Los tests viejos prueban la API v1 que este task elimina — no se conservan.

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";
import { scheduleAppointmentTool } from "../../src/tools/scheduleAppointment";

let env: any;
let appts: AppointmentsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  appts = new AppointmentsRepo(new Db(d1 as any));
  env = { DB: d1, CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPE_ID: "10", BOT_TIER: "pro" };
});

afterEach(() => vi.restoreAllMocks());

const args = {
  startTime: "2026-07-20T15:00:00Z",
  attendeeName: "Ana",
  attendeeEmail: "ana@example.com",
};

describe("scheduleAppointmentTool", () => {
  it("crea el booking en v2 y guarda la cita en D1", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { id: 555, uid: "uid-1", status: "accepted", start: "2026-07-20T15:00:00Z" } }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = scheduleAppointmentTool(env, () => "telegram:1");
    const res = (await tool.execute!(args, {} as any)) as any;

    expect(res.ok).toBe(true);
    expect(res.uid).toBe("uid-1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v2/bookings");

    const saved = await appts.findActive("telegram:1");
    expect(saved?.calcom_uid).toBe("uid-1");
    expect(saved?.status).toBe("confirmed");
    expect(saved?.attendee_email).toBe("ana@example.com");
  });

  it("no guarda nada en D1 si Cal.com rechaza", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    const tool = scheduleAppointmentTool(env, () => "telegram:1");
    const res = (await tool.execute!(args, {} as any)) as any;
    expect(res.error).toBe("http_400");
    expect(await appts.findActive("telegram:1")).toBeNull();
  });

  it("error si no hay conversación en contexto", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = scheduleAppointmentTool(env, () => null);
    const res = (await tool.execute!(args, {} as any)) as any;
    expect(res.error).toBe("no_conversation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("error si Cal.com no está configurado", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = scheduleAppointmentTool({ DB: env.DB } as any, () => "telegram:1");
    const res = (await tool.execute!(args, {} as any)) as any;
    expect(res.error).toBe("calcom_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/tools/scheduleAppointment.test.ts`
Expected: FAIL — la implementación actual usa v1 y no persiste en D1.

- [ ] **Step 3: Reescribir la tool**

Sobrescribir `src/tools/scheduleAppointment.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import {
  calcomConfigured,
  calcomTimeZone,
  createBooking,
  resolveEventTypeId,
} from "../integrations/calcom";

export function scheduleAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Agenda una cita en el calendario. Confirma primero el horario con checkAvailability. Necesitas fecha/hora, nombre y correo del cliente.",
    inputSchema: z.object({
      startTime: z.string().describe("Fecha y hora ISO, ej. 2026-07-20T15:00:00Z"),
      attendeeName: z.string().describe("Nombre del cliente"),
      attendeeEmail: z.string().email().describe("Correo del cliente"),
      attendeePhone: z.string().optional().describe("Teléfono del cliente, si lo dio"),
      servicio: z.string().optional().describe("Servicio que pidió, si lo mencionó"),
      notes: z.string().optional().describe("Notas para el dueño"),
    }),
    execute: async ({ startTime, attendeeName, attendeeEmail, attendeePhone, servicio, notes }) => {
      const conversationId = getConversationId();
      if (!conversationId) return { error: "no_conversation" as const };
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };

      const eventTypeId = resolveEventTypeId(env, servicio);
      if (eventTypeId === null) return { error: "calcom_not_configured" as const };

      const booking = await createBooking(env, {
        eventTypeId,
        start: startTime,
        name: attendeeName,
        email: attendeeEmail,
        timeZone: calcomTimeZone(env),
        phone: attendeePhone,
        notes,
      });
      // Solo persistimos si Cal.com confirmó: una fila sin booking real dejaría
      // al bot creyendo que el cliente tiene cita cuando no la tiene.
      if (!booking.ok) return { error: booking.reason };

      await new AppointmentsRepo(new Db(env.DB)).create({
        conversationId,
        calcomUid: booking.uid ?? String(booking.bookingId),
        eventTypeId,
        start: booking.start ?? startTime,
        attendeeName,
        attendeeEmail,
        attendeePhone,
      });

      return {
        ok: true as const,
        bookingId: booking.bookingId,
        uid: booking.uid,
        start: booking.start ?? startTime,
      };
    },
  });
}
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/tools/scheduleAppointment.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/tools/scheduleAppointment.ts test/tools/scheduleAppointment.test.ts
git commit -m "refactor(tools): scheduleAppointment sobre Cal.com v2 + persistencia en D1"
```

---

### Task 8: Tool rescheduleAppointment (con tope de 3)

**Files:**
- Create: `src/tools/rescheduleAppointment.ts`
- Test: `test/tools/rescheduleAppointment.test.ts`

**Interfaces:**
- Consumes: `AppointmentsRepo` (Task 3), `AppointmentChangeRequestsRepo` (Task 4), `TicketsRepo` con `appointmentChangeRequestId` (Task 5), `notifyOwner` de `src/tools/handoffHuman.ts`, `getAvailableSlots`/`resolveEventTypeId`/`calcomTimeZone`/`calcomConfigured` (calcom.ts)
- Produces: `rescheduleAppointmentTool(env, getConversationId): Tool`; constante exportada `MAX_RESCHEDULES = 3`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/tools/rescheduleAppointment.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";
import { AppointmentChangeRequestsRepo } from "../../src/db/appointmentChangeRequests";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { rescheduleAppointmentTool } from "../../src/tools/rescheduleAppointment";

let env: any;
let db: Db;
let appts: AppointmentsRepo;
let changes: AppointmentChangeRequestsRepo;
let convId: string;

const SLOT = "2026-07-25T16:00:00Z";

/** Cal.com responde que el slot propuesto SÍ está libre. */
function stubSlotsAvailable() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: { "2026-07-25": [{ start: SLOT }] } }), { status: 200 }),
    ),
  );
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  appts = new AppointmentsRepo(db);
  changes = new AppointmentChangeRequestsRepo(db);
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = {
    DB: d1,
    CALCOM_API_KEY: "cal_x",
    CALCOM_EVENT_TYPE_ID: "10",
    BOT_TIER: "pro",
    BUSINESS_NAME: "Test Biz",
    DASHBOARD_BASE_URL: "https://dash.test",
  };
});

afterEach(() => vi.restoreAllMocks());

async function seedAppointment() {
  return appts.create({
    conversationId: convId,
    calcomUid: "uid-1",
    eventTypeId: 10,
    start: "2026-07-20T15:00:00Z",
    attendeeName: "Ana",
    attendeeEmail: "ana@example.com",
  });
}

describe("rescheduleAppointmentTool", () => {
  it("crea la solicitud, marca la cita pendiente y abre un ticket ligado", async () => {
    const apptId = await seedAppointment();
    stubSlotsAvailable();

    const tool = rescheduleAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ newStartTime: SLOT }, {} as any)) as any;

    expect(res.ok).toBe(true);
    expect(res.pending).toBe(true);
    expect((await appts.findActive(convId))?.status).toBe("change_pending");

    const cr = await changes.getById(res.changeRequestId);
    expect(cr?.kind).toBe("reschedule");
    expect(cr?.proposed_start).toBe(SLOT);
    expect(cr?.status).toBe("pending");

    const tickets = await new TicketsRepo(db).listOpen();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].appointment_change_request_id).toBe(res.changeRequestId);
    expect(apptId).toBeGreaterThan(0);
  });

  it("no_appointment_found si la conversación no tiene cita", async () => {
    stubSlotsAvailable();
    const tool = rescheduleAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ newStartTime: SLOT }, {} as any)) as any;
    expect(res.error).toBe("no_appointment_found");
  });

  it("change_already_pending si ya hay un cambio en revisión", async () => {
    const apptId = await seedAppointment();
    await appts.setChangePending(apptId);
    stubSlotsAvailable();

    const tool = rescheduleAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ newStartTime: SLOT }, {} as any)) as any;
    expect(res.error).toBe("change_already_pending");
  });

  it("slot_unavailable devuelve las alternativas reales del día", async () => {
    await seedAppointment();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { "2026-07-25": [{ start: "2026-07-25T18:00:00Z" }] } }),
          { status: 200 },
        ),
      ),
    );

    const tool = rescheduleAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ newStartTime: SLOT }, {} as any)) as any;
    expect(res.error).toBe("slot_unavailable");
    expect(res.available).toEqual(["2026-07-25T18:00:00Z"]);
  });

  it("deja crear la TERCERA solicitud cuando solo hay 2 aprobadas", async () => {
    const apptId = await seedAppointment();
    for (let i = 0; i < 2; i++) {
      const id = await changes.create({
        appointmentId: apptId,
        conversationId: convId,
        kind: "reschedule",
        proposedStart: SLOT,
      });
      await changes.approve(id);
    }
    stubSlotsAvailable();

    const tool = rescheduleAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ newStartTime: SLOT }, {} as any)) as any;
    expect(res.ok).toBe(true);
  });

  it("reschedule_limit_reached con 3 aprobadas — y no crea nada nuevo", async () => {
    const apptId = await seedAppointment();
    for (let i = 0; i < 3; i++) {
      const id = await changes.create({
        appointmentId: apptId,
        conversationId: convId,
        kind: "reschedule",
        proposedStart: SLOT,
      });
      await changes.approve(id);
    }
    stubSlotsAvailable();

    const tool = rescheduleAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ newStartTime: SLOT }, {} as any)) as any;

    expect(res.error).toBe("reschedule_limit_reached");
    expect((await appts.findActive(convId))?.status).toBe("confirmed");
    expect(await new TicketsRepo(db).listOpen()).toHaveLength(0);
  });

  it("los rechazos NO cuentan contra el tope", async () => {
    const apptId = await seedAppointment();
    for (let i = 0; i < 5; i++) {
      const id = await changes.create({
        appointmentId: apptId,
        conversationId: convId,
        kind: "reschedule",
        proposedStart: SLOT,
      });
      await changes.reject(id);
    }
    stubSlotsAvailable();

    const tool = rescheduleAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ newStartTime: SLOT }, {} as any)) as any;
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/tools/rescheduleAppointment.test.ts`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implementar la tool**

Crear `src/tools/rescheduleAppointment.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import { AppointmentChangeRequestsRepo } from "../db/appointmentChangeRequests";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { notifyOwner } from "./handoffHuman";
import {
  calcomConfigured,
  calcomTimeZone,
  getAvailableSlots,
  resolveEventTypeId,
} from "../integrations/calcom";

/**
 * Tope duro de reagendamientos por cita. Al cuarto intento el bot deja de
 * generar solicitudes y escala a un humano: el patrón (mismo cliente, misma
 * cita, moviéndose otra vez) amerita una conversación real, no otro clic de
 * aprobación.
 */
export const MAX_RESCHEDULES = 3;

export function rescheduleAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Solicita mover la cita del cliente a otro horario. El cambio NO es inmediato: queda en revisión y el equipo lo confirma. " +
      "Si devuelve reschedule_limit_reached, no lo intentes de nuevo — usa handoffHuman para pasar la conversación a una persona. " +
      "Si devuelve slot_unavailable, ofrécele al cliente los horarios que vienen en `available`.",
    inputSchema: z.object({
      newStartTime: z.string().describe("Nuevo horario propuesto, ISO, ej. 2026-07-25T16:00:00Z"),
      reason: z.string().optional().describe("Motivo del cambio, si el cliente lo dio"),
    }),
    execute: async ({ newStartTime, reason }) => {
      const conversationId = getConversationId();
      if (!conversationId) return { error: "no_conversation" as const };
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };

      const db = new Db(env.DB);
      const appts = new AppointmentsRepo(db);
      const changes = new AppointmentChangeRequestsRepo(db);

      const appt = await appts.findActive(conversationId);
      if (!appt) return { error: "no_appointment_found" as const };
      if (appt.status === "change_pending") return { error: "change_already_pending" as const };

      const already = await changes.countApproved(appt.id, "reschedule");
      if (already >= MAX_RESCHEDULES) {
        return { error: "reschedule_limit_reached" as const, timesRescheduled: already };
      }

      // Validar contra el calendario ANTES de molestar al dueño: así nunca
      // llega a aprobación una solicitud sobre un horario ya ocupado.
      const eventTypeId = resolveEventTypeId(env, undefined) ?? appt.event_type_id;
      const day = newStartTime.slice(0, 10);
      const slots = await getAvailableSlots(env, eventTypeId, day, calcomTimeZone(env));
      if (!slots.ok) return { error: slots.reason };
      if (!slots.slots.some((s) => sameInstant(s, newStartTime))) {
        return { error: "slot_unavailable" as const, available: slots.slots };
      }

      const changeRequestId = await changes.create({
        appointmentId: appt.id,
        conversationId,
        kind: "reschedule",
        proposedStart: newStartTime,
        reason,
      });
      await appts.setChangePending(appt.id);

      const summary =
        `${appt.attendee_name} pide mover su cita del ${appt.start} al ${newStartTime}` +
        (reason ? ` — motivo: ${reason}` : "");
      const ticketId = await new TicketsRepo(db).create({
        conversationId,
        category: "agenda",
        summary,
        transcript: "",
        appointmentChangeRequestId: changeRequestId,
      });
      await new ConversationsRepo(db).setOpenTicket(conversationId, ticketId);
      await notifyOwner(env, { reason: "reagendar", summary, ticketId });

      return { ok: true as const, pending: true as const, changeRequestId, proposedStart: newStartTime };
    },
  });
}

/**
 * Compara dos instantes ISO. Cal.com devuelve los slots con offset local
 * ("2026-07-25T10:00:00.000-06:00") y el modelo suele proponer en UTC — una
 * comparación de strings diría que son distintos siendo el mismo momento.
 */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/tools/rescheduleAppointment.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/tools/rescheduleAppointment.ts test/tools/rescheduleAppointment.test.ts
git commit -m "feat(tools): rescheduleAppointment con aprobación humana y tope de 3"
```

---

### Task 9: Tool cancelAppointment

**Files:**
- Create: `src/tools/cancelAppointment.ts`
- Test: `test/tools/cancelAppointment.test.ts`

**Interfaces:**
- Consumes: los mismos repos y `notifyOwner` que la Task 8
- Produces: `cancelAppointmentTool(env, getConversationId): Tool`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/tools/cancelAppointment.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";
import { AppointmentChangeRequestsRepo } from "../../src/db/appointmentChangeRequests";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { cancelAppointmentTool } from "../../src/tools/cancelAppointment";

let env: any;
let db: Db;
let appts: AppointmentsRepo;
let changes: AppointmentChangeRequestsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  appts = new AppointmentsRepo(db);
  changes = new AppointmentChangeRequestsRepo(db);
  convId = (await new ConversationsRepo(db).getOrCreate("telegram", "u1")).id;
  env = { DB: d1, CALCOM_API_KEY: "cal_x", BOT_TIER: "pro", BUSINESS_NAME: "Test Biz", DASHBOARD_BASE_URL: "https://dash.test" };
});

afterEach(() => vi.restoreAllMocks());

async function seedAppointment() {
  return appts.create({
    conversationId: convId,
    calcomUid: "uid-1",
    eventTypeId: 10,
    start: "2026-07-20T15:00:00Z",
    attendeeName: "Ana",
    attendeeEmail: "ana@example.com",
  });
}

describe("cancelAppointmentTool", () => {
  it("crea la solicitud de cancelación SIN llamar a Cal.com", async () => {
    await seedAppointment();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = cancelAppointmentTool(env, () => convId);
    const res = (await tool.execute!({ reason: "ya no puedo" }, {} as any)) as any;

    expect(res.ok).toBe(true);
    expect(res.pending).toBe(true);
    // El bot nunca cancela por su cuenta: eso lo hace la aprobación del panel.
    expect(fetchMock).not.toHaveBeenCalled();

    const cr = await changes.getById(res.changeRequestId);
    expect(cr?.kind).toBe("cancel");
    expect(cr?.reason).toBe("ya no puedo");
    expect(cr?.status).toBe("pending");
    expect((await appts.findActive(convId))?.status).toBe("change_pending");
  });

  it("abre un ticket ligado a la solicitud", async () => {
    await seedAppointment();
    vi.stubGlobal("fetch", vi.fn());
    const tool = cancelAppointmentTool(env, () => convId);
    const res = (await tool.execute!({}, {} as any)) as any;

    const tickets = await new TicketsRepo(db).listOpen();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].appointment_change_request_id).toBe(res.changeRequestId);
  });

  it("no_appointment_found si no hay cita", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = cancelAppointmentTool(env, () => convId);
    expect(((await tool.execute!({}, {} as any)) as any).error).toBe("no_appointment_found");
  });

  it("change_already_pending si ya hay un cambio en revisión", async () => {
    const apptId = await seedAppointment();
    await appts.setChangePending(apptId);
    vi.stubGlobal("fetch", vi.fn());
    const tool = cancelAppointmentTool(env, () => convId);
    expect(((await tool.execute!({}, {} as any)) as any).error).toBe("change_already_pending");
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/tools/cancelAppointment.test.ts`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implementar la tool**

Crear `src/tools/cancelAppointment.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { AppointmentsRepo } from "../db/appointments";
import { AppointmentChangeRequestsRepo } from "../db/appointmentChangeRequests";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { notifyOwner } from "./handoffHuman";

export function cancelAppointmentTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Registra la solicitud de cancelación de la cita del cliente. La cancelación NO es inmediata: queda en revisión y el equipo la confirma. Dile eso al cliente, no le asegures que ya quedó cancelada.",
    inputSchema: z.object({
      reason: z.string().optional().describe("Motivo de la cancelación, si el cliente lo dio"),
    }),
    execute: async ({ reason }) => {
      const conversationId = getConversationId();
      if (!conversationId) return { error: "no_conversation" as const };

      const db = new Db(env.DB);
      const appts = new AppointmentsRepo(db);

      const appt = await appts.findActive(conversationId);
      if (!appt) return { error: "no_appointment_found" as const };
      if (appt.status === "change_pending") return { error: "change_already_pending" as const };

      const changeRequestId = await new AppointmentChangeRequestsRepo(db).create({
        appointmentId: appt.id,
        conversationId,
        kind: "cancel",
        reason,
      });
      await appts.setChangePending(appt.id);

      const summary =
        `${appt.attendee_name} pide cancelar su cita del ${appt.start}` +
        (reason ? ` — motivo: ${reason}` : "");
      const ticketId = await new TicketsRepo(db).create({
        conversationId,
        category: "agenda",
        summary,
        transcript: "",
        appointmentChangeRequestId: changeRequestId,
      });
      await new ConversationsRepo(db).setOpenTicket(conversationId, ticketId);
      await notifyOwner(env, { reason: "cancelar", summary, ticketId });

      return { ok: true as const, pending: true as const, changeRequestId };
    },
  });
}
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/tools/cancelAppointment.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/tools/cancelAppointment.ts test/tools/cancelAppointment.test.ts
git commit -m "feat(tools): cancelAppointment escala a aprobación humana"
```

---

### Task 10: Registrar las tools en tier Pro

**Files:**
- Modify: `src/tools/index.ts`
- Test: `test/tools/index.test.ts`

**Interfaces:**
- Consumes: las 4 tools de las Tasks 6–9
- Produces: `buildTools` devuelve 9 tools en Pro (5 free + `catalogQuery` + las 3 nuevas de agenda)

- [ ] **Step 1: Actualizar el test**

En `test/tools/index.test.ts`, reemplazar el test `"pro tier has the 5 base tools plus the 2 Pro tools"` por:

```ts
  it("pro tier suma las tools de agenda y catálogo", () => {
    const tools = buildTools(makeCtx("pro"));
    expect(Object.keys(tools).sort()).toEqual([
      "cancelAppointment",
      "captureLead",
      "catalogQuery",
      "checkAvailability",
      "handoffHuman",
      "pauseBot",
      "rescheduleAppointment",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
  });

  it("free tier no expone ninguna tool de agenda", () => {
    const tools = buildTools(makeCtx("free"));
    expect(tools.checkAvailability).toBeUndefined();
    expect(tools.scheduleAppointment).toBeUndefined();
    expect(tools.rescheduleAppointment).toBeUndefined();
    expect(tools.cancelAppointment).toBeUndefined();
  });
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/tools/index.test.ts`
Expected: FAIL — faltan `checkAvailability`, `rescheduleAppointment`, `cancelAppointment`.

- [ ] **Step 3: Registrar las tools**

En `src/tools/index.ts`, agregar los imports:

```ts
import { checkAvailabilityTool } from "./checkAvailability";
import { rescheduleAppointmentTool } from "./rescheduleAppointment";
import { cancelAppointmentTool } from "./cancelAppointment";
```

Y dentro del bloque `if (isPro(ctx.env))`:

```ts
  if (isPro(ctx.env)) {
    tools.checkAvailability = checkAvailabilityTool(ctx.env);
    tools.scheduleAppointment = scheduleAppointmentTool(ctx.env, ctx.getConversationId);
    tools.rescheduleAppointment = rescheduleAppointmentTool(ctx.env, ctx.getConversationId);
    tools.cancelAppointment = cancelAppointmentTool(ctx.env, ctx.getConversationId);
    tools.catalogQuery = catalogQueryTool(ctx.env);
  }
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/tools/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores. Revisar si `test/system-prompt.test.ts` o `test/agent.test.ts` afirman un número de tools; si alguno falla por el conteo, actualizar ese número — no la implementación.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts test/tools/index.test.ts
git commit -m "feat(tools): registrar las 4 tools de agenda en tier Pro"
```

---

### Task 11: Helper compartido para enviarle al cliente

**Files:**
- Create: `src/admin/conversationSend.ts`
- Modify: `src/admin/routes.ts:598-635` (ruta `POST /conversations/:id/reply`)
- Test: `test/admin/conversationSend.test.ts`

**Interfaces:**
- Consumes: `pickAdapter` (`src/replies/sender.ts`), `ConversationsRepo`, `MessagesRepo`
- Produces: `sendChannelMessage(env: Env, conversationId: string, text: string): Promise<{ ok: true; channel: string } | { ok: false; error: string }>`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/admin/conversationSend.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { sendChannelMessage } from "../../src/admin/conversationSend";

const sendReply = vi.fn(async () => {});
vi.mock("../../src/replies/sender", () => ({
  pickAdapter: () => ({ sendReply, showTyping: async () => {} }),
}));

let env: any;
let db: Db;
let convId: string;

beforeEach(async () => {
  sendReply.mockClear();
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  convId = (await new ConversationsRepo(db).getOrCreate("telegram", "u1")).id;
  env = { DB: d1 };
});

afterEach(() => vi.clearAllMocks());

describe("sendChannelMessage", () => {
  it("envía por el adapter y persiste el mensaje como 'owner'", async () => {
    const res = await sendChannelMessage(env, convId, "Tu cita quedó confirmada");
    expect(res.ok).toBe(true);
    expect(sendReply).toHaveBeenCalledTimes(1);

    const msgs = await new MessagesRepo(db).lastN(convId, 10);
    expect(msgs.some((m) => m.role === "owner" && m.content === "Tu cita quedó confirmada")).toBe(true);
  });

  it("error si la conversación no existe", async () => {
    const res = await sendChannelMessage(env, "telegram:999", "hola");
    expect(res.ok).toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("no persiste el mensaje si el envío falla", async () => {
    sendReply.mockRejectedValueOnce(new Error("canal caído"));
    const res = await sendChannelMessage(env, convId, "no debería guardarse");
    expect(res.ok).toBe(false);

    const msgs = await new MessagesRepo(db).lastN(convId, 10);
    expect(msgs.some((m) => m.content === "no debería guardarse")).toBe(false);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/admin/conversationSend.test.ts`
Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Implementar el helper**

Crear `src/admin/conversationSend.ts`:

```ts
import type { Env } from "../env";
import { Db } from "../db/client";
import { ConversationsRepo } from "../db/conversations";
import { MessagesRepo } from "../db/messages";
import { pickAdapter } from "../replies/sender";
import type { ChannelId } from "../channels/shared";

/**
 * Manda un mensaje al cliente por el canal de su conversación y lo guarda como
 * `role=owner`. Lo comparten la bandeja (responder como humano) y las rutas de
 * aprobación de citas, para no duplicar la secuencia adapter → persistir.
 *
 * Si el envío falla no persiste nada: el cliente nunca recibió el mensaje, y
 * un registro fantasma haría creer al dueño que sí se le avisó.
 */
export async function sendChannelMessage(
  env: Env,
  conversationId: string,
  text: string,
): Promise<{ ok: true; channel: string } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  const convs = new ConversationsRepo(db);
  const conv = await convs.getById(conversationId);
  if (!conv) return { ok: false, error: "Conversación no encontrada." };

  try {
    const adapter = pickAdapter(conv.channel as ChannelId, env);
    await adapter.sendReply(
      {
        channel: conv.channel as ChannelId,
        channelUserId: conv.channel_user_id,
        chunks: [text],
        interChunkDelayMs: 0,
      },
      env,
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  await new MessagesRepo(db).append(conversationId, "owner", text);
  await convs.touchLastMessage(conversationId);
  return { ok: true, channel: conv.channel };
}
```

- [ ] **Step 4: Refactorizar la ruta de reply para usar el helper**

En `src/admin/routes.ts`, reemplazar el cuerpo de `POST /conversations/:id/reply` (desde `const db = new Db(c.env.DB);` hasta antes de `c.header("X-Sent", "1");`) por:

```ts
  const sent = await sendChannelMessage(c.env, id, text);
  if (!sent.ok) {
    // Nada persistido en falla: el cliente nunca recibió el mensaje.
    return c.html(`<span class="text-red-600">✗ No se pudo enviar: ${escapeHtml(sent.error)}</span>`);
  }

  // El takeover (pausa del bot) es específico de la bandeja, no del helper: la
  // confirmación automática de una cita no debe callar al bot.
  await new ConversationsRepo(new Db(c.env.DB)).setPausedUntil(id, Date.now() + TAKEOVER_MS);
```

Y ajustar la línea final de éxito para usar `sent.channel`:

```ts
    `<span class="text-emerald-600">✓ Enviado por ${escapeHtml(channelLabel(sent.channel))}</span>` +
```

Agregar el import al inicio del archivo:

```ts
import { sendChannelMessage } from "./conversationSend";
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm test test/admin/conversationSend.test.ts test/admin/routes.test.ts`
Expected: PASS — la ruta de reply mantiene el mismo comportamiento observable.

- [ ] **Step 6: Typecheck y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores, sin regresiones.

- [ ] **Step 7: Commit**

```bash
git add src/admin/conversationSend.ts src/admin/routes.ts test/admin/conversationSend.test.ts
git commit -m "refactor(admin): extraer sendChannelMessage a helper compartido"
```

---

### Task 12: Aprobar / Rechazar en la vista de Tickets

**Files:**
- Modify: `src/admin/views/tickets.ts`
- Test: `test/admin/tickets-view.test.ts`

**Interfaces:**
- Consumes: `Ticket.appointment_change_request_id` (Task 5), `AppointmentChangeRequestsRepo.getById` (Task 4)
- Produces: `renderTickets(env)` muestra Aprobar/Rechazar en tickets de agenda; el resto sigue con "Resolver"

- [ ] **Step 1: Escribir el test que falla**

Crear `test/admin/tickets-view.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";
import { AppointmentsRepo } from "../../src/db/appointments";
import { AppointmentChangeRequestsRepo } from "../../src/db/appointmentChangeRequests";
import { renderTickets } from "../../src/admin/views/tickets";

let env: any;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  env = { DB: d1, BUSINESS_NAME: "Test Biz", BOT_TIER: "pro", BOT_LANGUAGE: "es" };
});

async function seedChangeTicket(kind: "reschedule" | "cancel") {
  const apptId = await new AppointmentsRepo(db).create({
    conversationId: "telegram:1",
    calcomUid: "uid-1",
    eventTypeId: 10,
    start: "2026-07-20T15:00:00Z",
    attendeeName: "Ana",
    attendeeEmail: "ana@example.com",
  });
  const crId = await new AppointmentChangeRequestsRepo(db).create({
    appointmentId: apptId,
    conversationId: "telegram:1",
    kind,
    proposedStart: kind === "reschedule" ? "2026-07-25T16:00:00Z" : undefined,
  });
  const ticketId = await new TicketsRepo(db).create({
    conversationId: null,
    category: "agenda",
    summary: kind === "reschedule" ? "Ana pide mover su cita" : "Ana pide cancelar su cita",
    transcript: "",
    appointmentChangeRequestId: crId,
  });
  return { ticketId, crId };
}

describe("renderTickets", () => {
  it("muestra Aprobar y Rechazar en un ticket de reagendado", async () => {
    const { ticketId } = await seedChangeTicket("reschedule");
    const html = await renderTickets(env);
    expect(html).toContain(`/admin/tickets/${ticketId}/approve-change`);
    expect(html).toContain(`/admin/tickets/${ticketId}/reject-change`);
    expect(html).toContain("Aprobar");
    expect(html).toContain("Rechazar");
    expect(html).toContain("2026-07-25T16:00:00Z"); // el horario propuesto es visible
  });

  it("incluye el campo de nota opcional en el rechazo", async () => {
    await seedChangeTicket("cancel");
    const html = await renderTickets(env);
    expect(html).toContain('name="note"');
  });

  it("un ticket normal conserva el form de Resolver", async () => {
    const id = await new TicketsRepo(db).create({
      conversationId: null,
      category: "product",
      summary: "Duda de producto",
      transcript: "",
    });
    const html = await renderTickets(env);
    expect(html).toContain(`/admin/tickets/${id}/resolve`);
    expect(html).not.toContain("approve-change");
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/admin/tickets-view.test.ts`
Expected: FAIL — el HTML no contiene `approve-change`.

- [ ] **Step 3: Implementar la vista**

En `src/admin/views/tickets.ts`, importar el repo nuevo:

```ts
import { AppointmentChangeRequestsRepo, type AppointmentChangeRequest } from "../../db/appointmentChangeRequests";
```

Reemplazar el cuerpo de `renderTickets` por:

```ts
export async function renderTickets(env: Env): Promise<string> {
  const db = new Db(env.DB);
  const repo = new TicketsRepo(db);
  const changes = new AppointmentChangeRequestsRepo(db);
  const open = await repo.listOpen();

  // Cargamos la solicitud de cambio de los tickets que la traen: son los
  // únicos que se resuelven con Aprobar/Rechazar en vez de "Resolver".
  const changeById = new Map<number, AppointmentChangeRequest>();
  for (const t of open) {
    const crId = t.appointment_change_request_id;
    if (crId == null) continue;
    const cr = await changes.getById(crId);
    if (cr) changeById.set(crId, cr);
  }

  const list = open
    .map((t) => {
      const date = new Date(t.created_at).toLocaleString("es-MX");
      const pillColor = STATUS_PILL[t.status] ?? "var(--muted)";
      const cr = t.appointment_change_request_id != null
        ? changeById.get(t.appointment_change_request_id)
        : undefined;
      return `<div class="tkcard bg-panel border border-line" style="padding:16px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:${pillColor};border:1px solid ${pillColor};padding:1px 6px;flex:none">${t.status.toUpperCase()}</span>
            <span class="font-display font-semibold text-[13px] text-cream truncate">${escapeHtml(t.category)}</span>
          </div>
          <span class="text-dim text-[11px]" style="flex:none">${date}</span>
        </div>
        <p class="text-muted text-[12.5px] leading-relaxed" style="margin:0 0 12px">${escapeHtml(t.summary)}</p>
        ${cr ? changeActions(t.id, cr) : resolveForm(t.id)}
      </div>`;
    })
    .join("");

  const body =
    open.length === 0
      ? `<div class="bg-panel border border-line" style="padding:40px 18px;text-align:center">
           <p class="text-dim text-[12.5px]">No hay tickets abiertos.</p>
         </div>`
      : list;

  return layout({ title: "Tickets", activeTab: "tickets", body, env });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Form clásico de los tickets normales: cerrar con el email de quien atendió. */
function resolveForm(ticketId: string): string {
  return `<form method="POST" action="/admin/tickets/${ticketId}/resolve" style="display:flex;gap:8px">
    <input name="resolved_by" placeholder="tu email" required
           style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 12px;font-size:12.5px;outline:none">
    <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer"
            style="background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:3px 3px 0 var(--linelit);padding:9px 16px">Resolver</button>
  </form>`;
}

/**
 * Ticket de agenda: aprobar ejecuta el cambio en Cal.com y le avisa al cliente;
 * rechazar lo deja como estaba y también le avisa (con la nota, si la hay).
 */
function changeActions(ticketId: string, cr: AppointmentChangeRequest): string {
  const detalle =
    cr.kind === "reschedule"
      ? `Nuevo horario propuesto: <b class="text-cream">${escapeHtml(cr.proposed_start ?? "")}</b>`
      : `Solicitud de <b class="text-cream">cancelación</b>`;
  return `<div style="border-top:1px solid var(--line);padding-top:12px">
    <p class="text-muted text-[12px]" style="margin:0 0 10px">${detalle}</p>
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
      <form method="POST" action="/admin/tickets/${ticketId}/approve-change">
        <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer"
                style="background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:3px 3px 0 var(--linelit);padding:9px 16px">Aprobar</button>
      </form>
      <form method="POST" action="/admin/tickets/${ticketId}/reject-change" style="display:flex;gap:8px;flex:1;min-width:240px">
        <input name="note" placeholder="Nota para el cliente (opcional)"
               style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 12px;font-size:12.5px;outline:none">
        <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer"
                style="background:var(--panel2);border:1px solid var(--line);color:var(--cream);padding:9px 16px">Rechazar</button>
      </form>
    </div>
  </div>`;
}
```

Agregar el import de `Db` si el archivo no lo tenía ya: `import { Db } from "../../db/client";` (ya está presente).

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/admin/tickets-view.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/admin/views/tickets.ts test/admin/tickets-view.test.ts
git commit -m "feat(admin): botones Aprobar/Rechazar en tickets de agenda"
```

---

### Task 13: Rutas de aprobación y rechazo

**Files:**
- Modify: `src/admin/routes.ts` (agregar después de `POST /tickets/:id/resolve`, ~línea 586)
- Test: `test/admin/appointment-routes.test.ts`

**Interfaces:**
- Consumes: `rescheduleBooking`/`cancelBooking` (Task 2), los dos repos (Tasks 3–4), `TicketsRepo` (Task 5), `sendChannelMessage` (Task 11)
- Produces: `POST /admin/tickets/:id/approve-change`, `POST /admin/tickets/:id/reject-change`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/admin/appointment-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";
import { AppointmentChangeRequestsRepo } from "../../src/db/appointmentChangeRequests";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { adminApp } from "../../src/admin/routes";
import { ADMIN_USERNAME } from "../../src/admin/auth";

const rescheduleBooking = vi.fn(async () => ({ ok: true, bookingId: 2, uid: "uid-2", start: "2026-07-25T16:00:00Z" }));
const cancelBooking = vi.fn(async () => ({ ok: true }));
vi.mock("../../src/integrations/calcom", async (orig) => ({
  ...(await orig<typeof import("../../src/integrations/calcom")>()),
  rescheduleBooking: (...a: any[]) => rescheduleBooking(...(a as [])),
  cancelBooking: (...a: any[]) => cancelBooking(...(a as [])),
}));

const sendChannelMessage = vi.fn(async () => ({ ok: true, channel: "telegram" }));
vi.mock("../../src/admin/conversationSend", () => ({
  sendChannelMessage: (...a: any[]) => sendChannelMessage(...(a as [])),
}));

const PASSWORD = "secret123";
const authHeaders = {
  Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${PASSWORD}`).toString("base64")}`,
  "Content-Type": "application/x-www-form-urlencoded",
};

let env: any;
let db: Db;
let appts: AppointmentsRepo;
let changes: AppointmentChangeRequestsRepo;
let tickets: TicketsRepo;
let convId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  rescheduleBooking.mockResolvedValue({ ok: true, bookingId: 2, uid: "uid-2", start: "2026-07-25T16:00:00Z" } as any);
  cancelBooking.mockResolvedValue({ ok: true } as any);
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  appts = new AppointmentsRepo(db);
  changes = new AppointmentChangeRequestsRepo(db);
  tickets = new TicketsRepo(db);
  convId = (await new ConversationsRepo(db).getOrCreate("telegram", "u1")).id;
  env = { DB: d1, DASHBOARD_PASSWORD: PASSWORD, BUSINESS_NAME: "Test Biz", BOT_TIER: "pro", BOT_LANGUAGE: "es", CALCOM_API_KEY: "cal_x" };
});

afterEach(() => vi.clearAllMocks());

async function seed(kind: "reschedule" | "cancel") {
  const apptId = await appts.create({
    conversationId: convId,
    calcomUid: "uid-1",
    eventTypeId: 10,
    start: "2026-07-20T15:00:00Z",
    attendeeName: "Ana",
    attendeeEmail: "ana@example.com",
  });
  const crId = await changes.create({
    appointmentId: apptId,
    conversationId: convId,
    kind,
    proposedStart: kind === "reschedule" ? "2026-07-25T16:00:00Z" : undefined,
  });
  await appts.setChangePending(apptId);
  const ticketId = await tickets.create({
    conversationId: convId,
    category: "agenda",
    summary: "s",
    transcript: "",
    appointmentChangeRequestId: crId,
  });
  return { apptId, crId, ticketId };
}

const post = (path: string, body?: string) =>
  adminApp.fetch(
    new Request(`https://bot.test${path}`, { method: "POST", headers: authHeaders, body: body ?? "" }),
    env,
  );

describe("POST /tickets/:id/approve-change", () => {
  it("reagenda en Cal.com, actualiza la cita y le avisa al cliente", async () => {
    const { crId, ticketId } = await seed("reschedule");
    const res = await post(`/tickets/${ticketId}/approve-change`);

    expect(res.status).toBe(302);
    expect(rescheduleBooking).toHaveBeenCalledTimes(1);

    const appt = await appts.findActive(convId);
    expect(appt?.calcom_uid).toBe("uid-2");
    expect(appt?.start).toBe("2026-07-25T16:00:00Z");
    expect(appt?.status).toBe("confirmed");
    expect((await changes.getById(crId))?.status).toBe("approved");
    expect((await tickets.getById(ticketId))?.status).toBe("resolved");
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("cancela en Cal.com y saca la cita de findActive", async () => {
    const { crId, ticketId } = await seed("cancel");
    await post(`/tickets/${ticketId}/approve-change`);

    expect(cancelBooking).toHaveBeenCalledTimes(1);
    expect(await appts.findActive(convId)).toBeNull();
    expect((await changes.getById(crId))?.status).toBe("approved");
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("si Cal.com falla, la solicitud sigue pendiente y no se avisa al cliente", async () => {
    rescheduleBooking.mockResolvedValueOnce({ ok: false, reason: "http_500" } as any);
    const { crId, ticketId } = await seed("reschedule");
    await post(`/tickets/${ticketId}/approve-change`);

    expect((await changes.getById(crId))?.status).toBe("pending");
    expect((await tickets.getById(ticketId))?.status).toBe("open");
    expect((await appts.findActive(convId))?.status).toBe("change_pending");
    expect(sendChannelMessage).not.toHaveBeenCalled();
  });
});

describe("POST /tickets/:id/reject-change", () => {
  it("revierte la cita, marca rechazo y avisa con la nota del dueño", async () => {
    const { crId, ticketId } = await seed("reschedule");
    const res = await post(`/tickets/${ticketId}/reject-change`, new URLSearchParams({ note: "Ese día está lleno" }).toString());

    expect(res.status).toBe(302);
    expect(rescheduleBooking).not.toHaveBeenCalled();
    expect((await appts.findActive(convId))?.status).toBe("confirmed");
    expect((await changes.getById(crId))?.status).toBe("rejected");
    expect((await tickets.getById(ticketId))?.status).toBe("resolved");
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect((sendChannelMessage.mock.calls[0] as any[])[2]).toBe("Ese día está lleno");
  });

  it("sin nota manda el mensaje por default", async () => {
    const { ticketId } = await seed("cancel");
    await post(`/tickets/${ticketId}/reject-change`);
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect((sendChannelMessage.mock.calls[0] as any[])[2]).toContain("no pudo confirmarse");
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm test test/admin/appointment-routes.test.ts`
Expected: FAIL — las rutas no existen (404 en vez de 302).

- [ ] **Step 3: Implementar las rutas**

En `src/admin/routes.ts`, agregar los imports:

```ts
import { AppointmentsRepo } from "../db/appointments";
import { AppointmentChangeRequestsRepo, type AppointmentChangeRequest } from "../db/appointmentChangeRequests";
import { rescheduleBooking, cancelBooking } from "../integrations/calcom";
```

Y agregar las rutas justo después de `POST /tickets/:id/resolve`:

```ts
/**
 * Aprueba una solicitud de cambio de cita: ejecuta el cambio real en Cal.com,
 * actualiza la cita, cierra el ticket y le avisa al cliente por su canal.
 *
 * Si Cal.com falla no se resuelve nada: la solicitud queda `pending` para que
 * el dueño reintente el clic sin perderla, y al cliente no se le promete un
 * cambio que no ocurrió.
 */
adminApp.post("/tickets/:id/approve-change", async (c) => {
  const ticketId = c.req.param("id");
  const db = new Db(c.env.DB);
  const ctx = await loadChangeContext(db, ticketId);
  if (!ctx) return c.redirect("/admin/tickets");
  const { cr, appt } = ctx;

  const appts = new AppointmentsRepo(db);
  let mensaje: string;

  if (cr.kind === "reschedule") {
    const res = await rescheduleBooking(c.env, appt.calcom_uid, cr.proposed_start ?? "", cr.reason ?? undefined);
    if (!res.ok) {
      console.error(`[approve-change] reschedule falló para el ticket ${ticketId}: ${res.reason}`);
      return c.redirect("/admin/tickets");
    }
    await appts.confirmAfterReschedule(appt.id, res.uid, res.start ?? cr.proposed_start ?? appt.start);
    mensaje = `Listo, tu cita quedó reprogramada para ${res.start ?? cr.proposed_start}.`;
  } else {
    const res = await cancelBooking(c.env, appt.calcom_uid, cr.reason ?? undefined);
    if (!res.ok) {
      console.error(`[approve-change] cancel falló para el ticket ${ticketId}: ${res.reason}`);
      return c.redirect("/admin/tickets");
    }
    await appts.markCancelled(appt.id);
    mensaje = "Listo, tu cita quedó cancelada.";
  }

  await new AppointmentChangeRequestsRepo(db).approve(cr.id);
  await new TicketsRepo(db).resolve(ticketId, ADMIN_USERNAME);
  const sent = await sendChannelMessage(c.env, cr.conversation_id, mensaje);
  if (!sent.ok) {
    // El cambio ya se ejecutó: no lo revertimos por un fallo de aviso, pero
    // dejamos rastro para que el dueño le escriba a mano desde la bandeja.
    console.error(`[approve-change] no se pudo avisar al cliente (${cr.conversation_id}): ${sent.error}`);
  }
  return c.redirect("/admin/tickets");
});

/**
 * Rechaza la solicitud: la cita vuelve a 'confirmed' sin tocar Cal.com, y el
 * cliente recibe la nota del dueño o un aviso por default.
 */
adminApp.post("/tickets/:id/reject-change", async (c) => {
  const ticketId = c.req.param("id");
  const db = new Db(c.env.DB);
  const ctx = await loadChangeContext(db, ticketId);
  if (!ctx) return c.redirect("/admin/tickets");
  const { cr, appt } = ctx;

  const form = await c.req.formData().catch(() => null);
  const note = String(form?.get("note") ?? "").trim();

  await new AppointmentsRepo(db).revertToConfirmed(appt.id);
  await new AppointmentChangeRequestsRepo(db).reject(cr.id);
  await new TicketsRepo(db).resolve(ticketId, ADMIN_USERNAME);

  const porDefecto =
    cr.kind === "reschedule"
      ? "Tu solicitud de cambio de horario no pudo confirmarse — nos pondremos en contacto contigo para ver otras opciones."
      : "Tu solicitud de cancelación no pudo confirmarse — nos pondremos en contacto contigo en breve.";
  const sent = await sendChannelMessage(c.env, cr.conversation_id, note || porDefecto);
  if (!sent.ok) {
    console.error(`[reject-change] no se pudo avisar al cliente (${cr.conversation_id}): ${sent.error}`);
  }
  return c.redirect("/admin/tickets");
});

/** Carga ticket → solicitud → cita. `null` si falta cualquiera de los tres. */
async function loadChangeContext(
  db: Db,
  ticketId: string,
): Promise<{ cr: AppointmentChangeRequest; appt: Appointment } | null> {
  const ticket = await new TicketsRepo(db).getById(ticketId);
  if (!ticket?.appointment_change_request_id) return null;
  const cr = await new AppointmentChangeRequestsRepo(db).getById(ticket.appointment_change_request_id);
  if (!cr || cr.status !== "pending") return null;
  const appt = await db.first<Appointment>("SELECT * FROM appointments WHERE id = ?", [cr.appointment_id]);
  return appt ? { cr, appt } : null;
}
```

Agregar también al import de tipos: `import type { Appointment } from "../db/appointments";` y verificar que `ADMIN_USERNAME` esté importado desde `./auth` (si no lo está, agregarlo).

- [ ] **Step 4: Correr los tests**

Run: `pnpm test test/admin/appointment-routes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores, sin regresiones.

- [ ] **Step 6: Commit**

```bash
git add src/admin/routes.ts test/admin/appointment-routes.test.ts
git commit -m "feat(admin): rutas approve-change y reject-change con aviso al cliente"
```

---

### Task 14: Runbook de despliegue

**Files:**
- Create: `docs/canales/calcom.md`

**Interfaces:**
- Consumes: todo lo anterior
- Produces: documentación operativa (sin código nuevo)

- [ ] **Step 1: Escribir el runbook**

Crear `docs/canales/calcom.md`:

````markdown
# Cal.com — ciclo completo de citas

Qué hace el bot con la agenda, cómo se despliega y qué revisar cuando algo falla.

## Qué hace el bot

| Acción | Quién la ejecuta |
|---|---|
| Consultar horarios libres | El bot, solo |
| Agendar una cita | El bot, solo |
| Reagendar | El bot **propone**; un humano aprueba en `/admin/tickets` |
| Cancelar | El bot **registra**; un humano aprueba en `/admin/tickets` |

El bot valida contra Cal.com que el horario propuesto esté libre **antes** de
mandar la solicitud a aprobación: al panel nunca llega una solicitud inválida.

**Tope:** una cita se puede reagendar 3 veces. Al cuarto intento el bot no
genera otra solicitud — pasa la conversación a un humano. Los rechazos no
cuentan contra el tope (la cita nunca se movió).

## Configuración

Secrets y variables (ya documentados en `src/env.ts`):

- `CALCOM_API_KEY` — secret de Cloudflare (`cal_...`)
- `CALCOM_EVENT_TYPE_ID` — event type por defecto
- `CALCOM_EVENT_TYPES` — opcional, JSON `{"corte":123,"barba":456}` para mapear servicio → event type
- `CALCOM_TIMEZONE` — default `America/Mexico_City`

Las tools de agenda son **tier Pro**: requieren `BOT_TIER=pro`.

## Despliegue

**El orden importa.** La migración va antes del deploy: si el código nuevo sube
primero, las tools escriben contra tablas que no existen y el bot falla en vivo.

```bash
# 1. Migración — tablas nuevas (idempotente, se puede repetir sin daño)
pnpm db:apply:remote

# 2. Columna nueva en `tickets`. SQLite no soporta ADD COLUMN IF NOT EXISTS,
#    así que esto se corre UNA sola vez por base. Si ya se corrió, falla con
#    "duplicate column name" — ese error es seguro de ignorar.
npx wrangler d1 execute horizontes_bot_db --remote \
  --command "ALTER TABLE tickets ADD COLUMN appointment_change_request_id INTEGER"

# 3. Verificar que las tablas quedaron
npx wrangler d1 execute horizontes_bot_db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'appointment%'"

# 4. Deploy
pnpm run deploy
```

## Prueba de humo tras el deploy

1. Escribirle al bot: "¿qué horarios tienes el viernes?" → debe listar horarios reales.
2. Agendar una cita → verificar que aparece en Cal.com.
3. Pedir moverla a otro horario libre → el bot dice que quedó **en revisión**, no que ya se movió.
4. Entrar a `/admin/tickets` → debe verse el ticket con **Aprobar / Rechazar**.
5. Aprobar → la cita se mueve en Cal.com y al cliente le llega la confirmación por su canal.

## Cuando algo falla

| Síntoma | Causa probable | Qué revisar |
|---|---|---|
| El bot dice que no hay horarios nunca | `CALCOM_EVENT_TYPE_ID` apunta a un event type inexistente | Verificar el id en Cal.com |
| `calcom_not_configured` | Falta `CALCOM_API_KEY` o el event type | `npx wrangler secret list` |
| `slot_unavailable` con horarios que sí se ven libres | Desfase de zona horaria | Revisar `CALCOM_TIMEZONE` contra la del calendario en Cal.com |
| El ticket sigue abierto tras aprobar | Cal.com rechazó el cambio | `npx wrangler tail` — buscar `[approve-change]` |
| El cambio se aplicó pero el cliente no recibió aviso | Falló el envío por el canal | `npx wrangler tail` — buscar "no se pudo avisar"; escribirle a mano desde la bandeja |
| El bot ya no deja reagendar | Se alcanzó el tope de 3 | Es el comportamiento esperado: la conversación pasa a un humano |
````

- [ ] **Step 2: Verificar la suite completa una última vez**

Run: `pnpm test && pnpm typecheck`
Expected: todo verde. Anotar el número final de tests para el reporte de cierre.

- [ ] **Step 3: Commit**

```bash
git add docs/canales/calcom.md
git commit -m "docs: runbook de despliegue del ciclo completo de Cal.com"
```

---

## Verificación final

Antes de dar el trabajo por terminado:

- [ ] `pnpm test` — toda la suite en verde (no solo los archivos nuevos)
- [ ] `pnpm typecheck` — sin errores
- [ ] `git log --oneline` — un commit por task, mensajes descriptivos
- [ ] Revisión de la rama completa (no solo task por task): buscar inconsistencias que solo se ven mirando el diff entero — nombres de campos que no coinciden entre repos y rutas, tools registradas pero nunca invocables, mensajes al cliente que prometan algo distinto de lo que el sistema hace.
- [ ] La migración **no** se ha corrido contra producción todavía — eso es un paso de despliegue deliberado, con el runbook de la Task 14 en la mano.
