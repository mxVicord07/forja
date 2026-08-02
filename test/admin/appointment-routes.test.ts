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
