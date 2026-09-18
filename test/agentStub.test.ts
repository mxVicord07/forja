import { describe, it, expect, vi } from "vitest";
import { getAgentStub, agentStub, parseLocationHint } from "../src/agentStub";
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
    expect(AGENT.get).toHaveBeenCalledWith("id:wnam:instagram:99", { locationHint: "wnam" });
  });

  it("el nombre se sala con la región — un DO viejo sin hint no queda pegado al colo original para siempre", () => {
    const AGENT = ns();
    // Sin hint: nombre tal cual (esto es lo que ya tienen todas las
    // conversaciones existentes, porque AGENT_LOCATION_HINT nunca estuvo
    // configurado en producción hasta ahora).
    getAgentStub({ AGENT } as unknown as Env, "whatsapp:5215500000");
    expect(AGENT.get).toHaveBeenCalledWith("id:whatsapp:5215500000");

    // Al fijar el hint, la MISMA conversación nace en un DO nuevo (nombre
    // salado) — no un no-op silencioso que la deja atrapada en el colo viejo.
    getAgentStub(
      { AGENT, AGENT_LOCATION_HINT: "enam" } as unknown as Env,
      "whatsapp:5215500000",
    );
    expect(AGENT.get).toHaveBeenCalledWith("id:enam:whatsapp:5215500000", { locationHint: "enam" });
  });
});

describe("agentStub — channel/channelUserId separados (firma que espera api-inbox.ts)", () => {
  function ns() {
    const get = vi.fn((id: unknown, opts?: unknown) => ({ id, opts }));
    return { get, idFromName: (name: string) => `id:${name}` };
  }

  it("resuelve al MISMO Durable Object que getAgentStub con el nombre ya combinado", () => {
    const AGENT = ns();
    agentStub({ AGENT } as unknown as Env, "telegram", "12345");
    expect(AGENT.get).toHaveBeenCalledWith("id:telegram:12345");
  });
});
