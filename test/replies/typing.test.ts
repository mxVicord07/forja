import { describe, it, expect, vi, afterEach } from "vitest";
import {
  supportsTyping,
  showTypingSafe,
  startTypingKeepalive,
} from "../../src/replies/typing";
import type { ChannelAdapter } from "../../src/channels/shared";

const env = {} as any;

function adapterWith(showTyping?: ChannelAdapter["showTyping"]): ChannelAdapter {
  return {
    parseIncoming: async () => ({}) as any,
    sendReply: async () => {},
    ...(showTyping ? { showTyping } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("supportsTyping", () => {
  it("es falso si el adapter no implementa showTyping", () => {
    expect(supportsTyping(adapterWith(), "telegram")).toBe(false);
  });

  it("es falso en canales sin soporte del proveedor, aunque el adapter lo implemente", () => {
    const a = adapterWith(async () => {});
    expect(supportsTyping(a, "manychat")).toBe(false);
    expect(supportsTyping(a, "twilio")).toBe(false);
  });

  it("es verdadero en los canales soportados", () => {
    const a = adapterWith(async () => {});
    for (const ch of ["telegram", "whatsapp", "messenger", "instagram"] as const) {
      expect(supportsTyping(a, ch)).toBe(true);
    }
  });
});

describe("showTypingSafe", () => {
  it("le pasa canal e id del mensaje del proveedor al adapter", async () => {
    const showTyping = vi.fn(async () => {});
    await showTypingSafe(adapterWith(showTyping), "whatsapp", "5215512345678", env, "wamid.X");
    expect(showTyping).toHaveBeenCalledWith("5215512345678", env, {
      channel: "whatsapp",
      providerMessageId: "wamid.X",
    });
  });

  it("no lanza si el proveedor falla — el indicador jamás bloquea la respuesta", async () => {
    const showTyping = vi.fn(async () => {
      throw new Error("401 token vencido");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      showTypingSafe(adapterWith(showTyping), "telegram", "42", env),
    ).resolves.toBeUndefined();
  });

  it("no llama nada en un canal sin soporte", async () => {
    const showTyping = vi.fn(async () => {});
    await showTypingSafe(adapterWith(showTyping), "manychat", "42", env);
    expect(showTyping).not.toHaveBeenCalled();
  });
});

describe("startTypingKeepalive", () => {
  it("enciende de inmediato y lo re-enciende mientras el bot piensa", async () => {
    vi.useFakeTimers();
    const showTyping = vi.fn(async () => {});
    const stop = startTypingKeepalive(adapterWith(showTyping), "telegram", "42", env);
    expect(showTyping).toHaveBeenCalledTimes(1); // disparo inmediato
    await vi.advanceTimersByTimeAsync(9000); // Telegram refresca cada 4s
    expect(showTyping).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(showTyping).toHaveBeenCalledTimes(3); // ya no late tras stop()
  });

  it("se apaga solo si el turno se cuelga (tope duro)", async () => {
    vi.useFakeTimers();
    const showTyping = vi.fn(async () => {});
    startTypingKeepalive(adapterWith(showTyping), "telegram", "42", env);
    await vi.advanceTimersByTimeAsync(200_000);
    // 1 inmediato + ~22 refrescos dentro de los 90s de tope, y nada después.
    const atCap = showTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(showTyping.mock.calls.length).toBe(atCap);
    expect(atCap).toBeLessThan(30);
  });

  it("en un canal sin soporte devuelve un stop() inerte y no llama al proveedor", () => {
    const showTyping = vi.fn(async () => {});
    const stop = startTypingKeepalive(adapterWith(showTyping), "manychat", "42", env);
    expect(showTyping).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
