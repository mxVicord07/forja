import { describe, it, expect, vi } from "vitest";
import {
  sendChunkedReply,
  pickAdapter,
  chunkDelayMs,
} from "../../src/replies/sender";
import type { ChannelAdapter } from "../../src/channels/shared";

describe("sendChunkedReply", () => {
  it("invokes adapter.sendReply with all chunks", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "telegram", "user_1", ["a", "b", "c"], {} as any);
    expect(sendReply).toHaveBeenCalledOnce();
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.chunks).toEqual(["a", "b", "c"]);
    expect(arg.channelUserId).toBe("user_1");
  });

  it("passes channel and env through to the adapter", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    const env = { BOT_NAME: "horizontes" } as any;
    await sendChunkedReply(adapter, "twilio", "+5215555", ["hola"], env);
    const [reply, passedEnv] = sendReply.mock.calls[0] as any[];
    expect(reply.channel).toBe("twilio");
    expect(passedEnv).toBe(env);
  });

  it("respects an explicit interChunkDelayMs", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "manychat", "u", ["one", "two"], {} as any, 2222);
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.interChunkDelayMs).toBe(2222);
  });

  it("defaults to a clamped, length-proportional delay for multi-chunk replies", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "telegram", "u", ["short", "next"], {} as any);
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.interChunkDelayMs).toBeGreaterThanOrEqual(800);
    expect(arg.interChunkDelayMs).toBeLessThanOrEqual(1500);
  });

  it("does not set a default delay for a single-chunk reply", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "telegram", "u", ["only one"], {} as any);
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.interChunkDelayMs).toBeUndefined();
  });
});

describe("chunkDelayMs", () => {
  it("clamps short chunks up to the minimum (800ms)", () => {
    expect(chunkDelayMs("hi")).toBe(800); // 2 * 30 = 60 -> clamped to 800
  });

  it("clamps long chunks down to the maximum (1500ms)", () => {
    const long = "x".repeat(200); // 200 * 30 = 6000 -> clamped to 1500
    expect(chunkDelayMs(long)).toBe(1500);
  });

  it("scales proportionally inside the band", () => {
    const mid = "y".repeat(40); // 40 * 30 = 1200, within [800, 1500]
    expect(chunkDelayMs(mid)).toBe(1200);
  });
});

describe("pickAdapter", () => {
  const env = {} as any;

  it("maps each channel to an adapter exposing sendReply", () => {
    for (const ch of ["telegram", "manychat", "twilio"] as const) {
      const adapter = pickAdapter(ch, env);
      expect(typeof adapter.sendReply).toBe("function");
      expect(typeof adapter.parseIncoming).toBe("function");
    }
  });

  it("throws on an unknown channel", () => {
    expect(() => pickAdapter("sms" as any, env)).toThrow(/unknown channel/);
  });

  it("whatsapp usa el adapter de Meta por defecto", async () => {
    const { whatsappAdapter } = await import("../../src/channels/whatsapp");
    expect(pickAdapter("whatsapp", {} as any)).toBe(whatsappAdapter);
    expect(pickAdapter("whatsapp", { WA_PROVIDER: "meta" } as any)).toBe(whatsappAdapter);
  });

  it("whatsapp usa YCloud cuando WA_PROVIDER=ycloud", async () => {
    const { ycloudAdapter } = await import("../../src/channels/ycloud");
    expect(pickAdapter("whatsapp", { WA_PROVIDER: "ycloud" } as any)).toBe(ycloudAdapter);
  });

  it("un WA_PROVIDER no reconocido cae a Meta pero deja rastro en el log", async () => {
    const { whatsappAdapter } = await import("../../src/channels/whatsapp");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(pickAdapter("whatsapp", { WA_PROVIDER: "yclod" } as any)).toBe(whatsappAdapter);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
