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

  it("muestra el motivo de cancelación cuando viene presente", async () => {
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
      kind: "cancel",
      reason: "ya no puedo ese día",
    });
    await new TicketsRepo(db).create({
      conversationId: null,
      category: "agenda",
      summary: "Ana pide cancelar su cita",
      transcript: "",
      appointmentChangeRequestId: crId,
    });
    const html = await renderTickets(env);
    expect(html).toContain("ya no puedo ese día");
  });

  it("marca con el indicador de error solo la tarjeta del ticket que falló al aprobar", async () => {
    await seedChangeTicket("reschedule"); // ticket "sano", no debe llevar el aviso
    const { ticketId: failedId } = await seedChangeTicket("cancel");

    const html = await renderTickets(env, failedId);
    expect(html).toContain("No se pudo ejecutar el cambio en Cal.com");
    // Aparece exactamente una vez: la otra tarjeta (misma vista) no lo lleva,
    // aunque ambas usen exactamente el mismo markup de changeActions().
    expect(html.split("No se pudo ejecutar el cambio en Cal.com").length - 1).toBe(1);

    // El aviso vive dentro de la tarjeta del ticket fallido específicamente
    // (cada tarjeta es un <div class="tkcard...> independiente).
    const cards = html.split('<div class="tkcard');
    const failedCard = cards.find((c) => c.includes(failedId));
    expect(failedCard).toContain("No se pudo ejecutar el cambio en Cal.com");
    const otherCards = cards.filter((c) => !c.includes(failedId));
    for (const c of otherCards) {
      expect(c).not.toContain("No se pudo ejecutar el cambio en Cal.com");
    }
  });

  it("sin failedTicketId ninguna tarjeta muestra el indicador de error", async () => {
    await seedChangeTicket("reschedule");
    const html = await renderTickets(env);
    expect(html).not.toContain("No se pudo ejecutar el cambio en Cal.com");
  });
});
