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
