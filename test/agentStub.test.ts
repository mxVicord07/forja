import { describe, it, expect, vi } from "vitest";
import { getAgentStub, parseLocationHint } from "../src/agentStub";
import type { Env } from "../src/env";

describe("parseLocationHint", () => {
  it("acepta hints válidos", () => {
    expect(parseLocationHint("wnam")).toBe("wnam");
    expect(parseLocationHint(" ENAM ")).toBe("enam");
    expect(parseLocationHint("apac")).toBe("apac");
  });
  it("ignora vacío o basura (no rompe get())", () => {
    expect(parseLocationHint("")).toBeUndefined();
    expect(parseLocationHint("mexico")).toBeUndefined();
    expect(parseLocationHint(undefined)).toBeUndefined();
  });
});

describe("getAgentStub", () => {
  function ns() {
    const get = vi.fn((id: unknown, opts?: unknown) => ({ id, opts, ingest: vi.fn() }));
    return {
      get,
      idFromName: (name: string) => `id:${name}`,
    };
  }

  it("sin hint llama get(id) a secas — no cambia bots que no lo setean", () => {
    const AGENT = ns();
    getAgentStub({ AGENT } as unknown as Env, "telegram:1");
    expect(AGENT.get).toHaveBeenCalledWith("id:telegram:1");
    expect(AGENT.get.mock.calls[0][1]).toBeUndefined();
  });

  it("AGENT_LOCATION_HINT=wnam se pasa a get() — el env var solo no bastaba", () => {
    const AGENT = ns();
    getAgentStub(
      { AGENT, AGENT_LOCATION_HINT: "wnam" } as unknown as Env,
      "instagram:99",
    );
    expect(AGENT.get).toHaveBeenCalledWith("id:instagram:99", { locationHint: "wnam" });
  });
});
