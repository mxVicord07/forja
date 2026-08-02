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
