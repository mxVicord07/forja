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
    expect(String((fetchMock.mock.calls[0] as any[])[0])).toContain("/v2/bookings");

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

  it("rechaza agendar si el contacto ya tiene una cita activa", async () => {
    await appts.create({
      conversationId: "telegram:1",
      calcomUid: "uid-previa",
      eventTypeId: 10,
      start: "2026-07-10T12:00:00Z",
      attendeeName: "Ana",
      attendeeEmail: "ana@example.com",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = scheduleAppointmentTool(env, () => "telegram:1");
    const res = (await tool.execute!(args, {} as any)) as any;

    expect(res.error).toBe("appointment_already_exists");
    expect(res.existingStart).toBe("2026-07-10T12:00:00Z");
    // No debe crear un booking nuevo en Cal.com ni una segunda fila.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("una cita cancelada NO bloquea agendar de nuevo", async () => {
    const previa = await appts.create({
      conversationId: "telegram:1",
      calcomUid: "uid-previa",
      eventTypeId: 10,
      start: "2026-07-10T12:00:00Z",
      attendeeName: "Ana",
      attendeeEmail: "ana@example.com",
    });
    await appts.markCancelled(previa);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { id: 555, uid: "uid-1", start: "2026-07-20T15:00:00Z" } }), { status: 201 }),
      ),
    );

    const tool = scheduleAppointmentTool(env, () => "telegram:1");
    const res = (await tool.execute!(args, {} as any)) as any;
    expect(res.ok).toBe(true);
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
