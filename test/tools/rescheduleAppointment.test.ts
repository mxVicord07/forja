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
