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

  it("getById encuentra la cita aunque esté cancelada", async () => {
    const id = await repo.create(base);
    await repo.markCancelled(id);
    expect((await repo.getById(id))?.status).toBe("cancelled");
    expect(await repo.getById(9999)).toBeNull();
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

  it("listBetween trae las citas del rango, ordenadas, en cualquier formato de fecha", async () => {
    await repo.create({ ...base, calcomUid: "dentro-1", start: "2026-11-17T10:00:00Z" });
    await repo.create({ ...base, calcomUid: "dentro-2", start: "2026-11-16T16:00:00.000Z" });
    await repo.create({ ...base, calcomUid: "antes", start: "2026-11-15T23:59:59Z" });
    await repo.create({ ...base, calcomUid: "despues", start: "2026-11-30T06:00:00.000Z" });
    const r = await repo.listBetween("2026-11-16T06:00:00.000Z", "2026-11-30T06:00:00.000Z");
    expect(r.map((a) => a.calcom_uid)).toEqual(["dentro-2", "dentro-1"]);
  });
});
