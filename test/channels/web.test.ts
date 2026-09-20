import { describe, it, expect } from "vitest";
import { webAdapter } from "../../src/channels/web";
import type { Env } from "../../src/env";

function makeReq(body: unknown): Request {
  return new Request("https://bot.test/demo/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const env = {} as Env;

describe("webAdapter.parseIncoming", () => {
  it("parses sessionId + text into an IncomingMessage on channel 'web'", async () => {
    const msg = await webAdapter.parseIncoming(makeReq({ sessionId: "abc-123", text: "hola" }), env);
    expect(msg.channel).toBe("web");
    expect(msg.channelUserId).toBe("abc-123");
    expect(msg.text).toBe("hola");
    expect(msg.displayName).toBeUndefined();
  });

  it("keeps an optional display name, trimmed and capped at 60 chars", async () => {
    const longName = "N".repeat(80);
    const msg = await webAdapter.parseIncoming(
      makeReq({ sessionId: "abc-123", text: "hola", name: `  ${longName}  ` }),
      env,
    );
    expect(msg.displayName).toBe(longName.slice(0, 60));
  });

  it("caps sessionId at 64 chars (anti-abuso contra el nombre del Durable Object)", async () => {
    const longSid = "s".repeat(100);
    const msg = await webAdapter.parseIncoming(makeReq({ sessionId: longSid, text: "hola" }), env);
    expect(msg.channelUserId).toBe(longSid.slice(0, 64));
  });

  it("caps text at 2000 chars", async () => {
    const longText = "a".repeat(3000);
    const msg = await webAdapter.parseIncoming(makeReq({ sessionId: "abc", text: longText }), env);
    expect(msg.text?.length).toBe(2000);
  });

  it("throws if sessionId is missing", async () => {
    await expect(webAdapter.parseIncoming(makeReq({ text: "hola" }), env)).rejects.toThrow(
      /falta sessionId o text/,
    );
  });

  it("throws if text is missing", async () => {
    await expect(webAdapter.parseIncoming(makeReq({ sessionId: "abc" }), env)).rejects.toThrow(
      /falta sessionId o text/,
    );
  });

  it("throws on empty/whitespace-only text", async () => {
    await expect(webAdapter.parseIncoming(makeReq({ sessionId: "abc", text: "   " }), env)).rejects.toThrow();
  });
});

describe("webAdapter.sendReply", () => {
  it("is a no-op — never throws, nothing to push (the browser polls D1)", async () => {
    await expect(
      webAdapter.sendReply({ channel: "web", channelUserId: "abc", chunks: ["hola"] }, env),
    ).resolves.toBeUndefined();
  });
});
