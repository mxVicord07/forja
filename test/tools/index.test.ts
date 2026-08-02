import { describe, it, expect } from "vitest";
import { buildTools, type ToolContext } from "../../src/tools/index";

function makeCtx(tier: "free" | "pro", niche?: string): ToolContext {
  const env = {
    BOT_TIER: tier,
    BOT_NICHE: niche,
    DB: {} as any,
    AI: {} as any,
    BUSINESS_NAME: "Test",
    OWNER_EMAIL: "owner@test.com",
    DASHBOARD_BASE_URL: "https://example.com",
  } as any;
  return { env, getConversationId: () => "conv-1" };
}

describe("buildTools", () => {
  it("registers the 5 free-tier tools (incluye captureLead)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
  });

  it("free tier captura leads pero excluye las Pro-only avanzadas", () => {
    const tools = buildTools(makeCtx("free"));
    expect(tools.captureLead).toBeDefined();
    expect(tools.scheduleAppointment).toBeUndefined();
    expect(tools.catalogQuery).toBeUndefined();
  });

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

  it("el Starter genérico no agrega tools de nicho (aunque BOT_NICHE traiga un giro)", () => {
    for (const niche of [undefined, "restaurante", "inmobiliaria", "hoteleria"]) {
      const tools = buildTools(makeCtx("pro", niche));
      expect(tools.crearReservacion).toBeUndefined();
      expect(tools.calificarComprador).toBeUndefined();
      expect(tools.agendarCita).toBeUndefined();
      expect(tools.registrarPedido).toBeUndefined();
      expect(tools.registrarProspecto).toBeUndefined();
      expect(tools.reservarHospedaje).toBeUndefined();
    }
  });
});
