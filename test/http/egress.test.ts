import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EGRESS_USER_AGENT,
  sanitizeHeaderValue,
  sanitizeHeaders,
  egressFetch,
  probeMessagesEndpoint,
} from "../../src/http/egress";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeHeaderValue", () => {
  it("quita CR/LF y controles (secret de Windows)", () => {
    expect(sanitizeHeaderValue("sk-ant-xxx\r\n")).toBe("sk-ant-xxx");
    expect(sanitizeHeaderValue("  tok\u0000en  ")).toBe("token");
  });
});

describe("sanitizeHeaders", () => {
  it("pone User-Agent si falta", () => {
    const h = sanitizeHeaders({ "x-api-key": "sk-ant" });
    expect(h.get("User-Agent")).toBe(EGRESS_USER_AGENT);
    expect(h.get("x-api-key")).toBe("sk-ant");
  });

  it("respeta un User-Agent ya puesto y limpia CR", () => {
    const h = sanitizeHeaders({ "User-Agent": "Mio/1\r", "x-api-key": "sk\r\n" });
    expect(h.get("User-Agent")).toBe("Mio/1");
    expect(h.get("x-api-key")).toBe("sk");
  });

  it("no reenvía headers hop-by-hop / CF spoofeables", () => {
    const h = sanitizeHeaders({
      "CF-Connecting-IP": "1.2.3.4",
      Connection: "close",
      "x-api-key": "sk",
    });
    expect(h.has("CF-Connecting-IP")).toBe(false);
    expect(h.has("Connection")).toBe(false);
    expect(h.get("x-api-key")).toBe("sk");
  });
});

describe("egressFetch", () => {
  it("llama a fetch con User-Agent", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await egressFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("User-Agent")).toBe(EGRESS_USER_AGENT);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("loguea 400 con cuerpo vacío (firma WAF/edge)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 400,
        headers: { "content-length": "0", connection: "close", "cf-ray": "abc-MEX" },
      }),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await egressFetch("https://api.anthropic.com/v1/messages");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("[egress] 400 empty-body"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("cf-ray=abc-MEX"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("edge/WAF"));
  });
});

describe("probeMessagesEndpoint", () => {
  it("marca origin=false ante 400 vacío", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 400, headers: { "content-length": "0" } }),
    );
    const r = await probeMessagesEndpoint("https://api.anthropic.com/");
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.reachedOriginLikely).toBe(false);
    expect(r.bodyChars).toBe(0);
  });

  it("marca origin=true si hay JSON (aunque sea error)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"type":"error"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await probeMessagesEndpoint("https://api.anthropic.com");
    expect(r.reachedOriginLikely).toBe(true);
    expect(r.status).toBe(401);
  });
});
