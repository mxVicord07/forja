import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";

let repo: TicketsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  repo = new TicketsRepo(new Db(d1 as any));
});

describe("TicketsRepo", () => {
  it("creates open ticket", async () => {
    const id = await repo.create({
      conversationId: null,
      category: "product",
      summary: "Pregunta sobre shampoo",
      transcript: "user: hola\nbot: ...",
    });
    const ticket = await repo.getById(id);
    expect(ticket?.status).toBe("open");
    expect(ticket?.summary).toBe("Pregunta sobre shampoo");
  });

  it("resolve sets status + resolved_at", async () => {
    const id = await repo.create({
      conversationId: null,
      category: "other",
      summary: "x",
      transcript: "",
    });
    await repo.resolve(id, "agente@ejemplo.com");
    const ticket = await repo.getById(id);
    expect(ticket?.status).toBe("resolved");
    expect(ticket?.resolved_at).toBeTruthy();
    expect(ticket?.resolved_by).toBe("agente@ejemplo.com");
  });

  it("listOpen returns only open tickets", async () => {
    await repo.create({ conversationId: null, category: "x", summary: "a", transcript: "" });
    const idResolved = await repo.create({ conversationId: null, category: "x", summary: "b", transcript: "" });
    await repo.resolve(idResolved, "agente@x.com");
    const list = await repo.listOpen();
    expect(list).toHaveLength(1);
    expect(list[0].summary).toBe("a");
  });

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
});
