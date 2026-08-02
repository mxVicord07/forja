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
