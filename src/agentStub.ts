import type { Env } from "./env";

/**
 * Location hints for Durable Objects (`get(id, { locationHint })`).
 * Only honored the FIRST time that Object is created — existing DOs stay put.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint
 */
export const AGENT_LOCATION_HINTS = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
] as const;

export type AgentLocationHint = (typeof AGENT_LOCATION_HINTS)[number];

export function parseLocationHint(raw: string | undefined | null): AgentLocationHint | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return (AGENT_LOCATION_HINTS as readonly string[]).includes(v)
    ? (v as AgentLocationHint)
    : undefined;
}

/**
 * Resolve the SupportAgent stub, applying `AGENT_LOCATION_HINT` when set.
 *
 * The env var alone does nothing: Workers only read the hint from `get()`.
 * LLM calls run *inside* the Durable Object, so its colo is the egress IP
 * Anthropic/Zernio see. Pinning to `wnam`/`enam` keeps that near US APIs.
 */
export function getAgentStub(env: Env, name: string) {
  const id = env.AGENT.idFromName(name);
  const hint = parseLocationHint(env.AGENT_LOCATION_HINT);
  return hint ? env.AGENT.get(id, { locationHint: hint }) : env.AGENT.get(id);
}
