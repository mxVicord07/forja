import type { Env } from "./env";

/**
 * Location hints for Durable Objects (`get(id, { locationHint })`).
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
 * AGENT_LOCATION_HINT (opcional, p.ej. "enam") existe para el 403 "Request not
 * allowed" de Anthropic: el DO nace en el colo cercano a quien manda el
 * webhook, y si el proveedor del canal tiene servidores en Asia (p.ej. YCloud)
 * el agente queda corriendo allá — el edge de api.anthropic.com veta ese
 * origen en TODAS las llamadas al LLM. Con el hint en Norteamérica el egress
 * sale de EE.UU. y pasa, con la misma API key. El env var SOLO no basta:
 * Workers solo leen el hint desde `get()`.
 *
 * El hint solo aplica al CREAR el Durable Object — uno que ya existe se queda
 * donde nació (limitación de Cloudflare, no de este código). Por eso el
 * NOMBRE se sala con la región cuando hay hint: sin salar, fijar la variable
 * en un bot con conversaciones viejas sería un no-op silencioso para ellas
 * (seguirían en el colo original para siempre). Salando, nacen DOs frescos en
 * la región correcta. El costo es aceptable y acotado: se pierde el buffer de
 * segundos en vuelo en ese instante (si había un mensaje a medio bufferear) —
 * el historial real de la conversación vive en D1, no en el DO, así que nada
 * de eso se pierde. Sin la var: nombre y comportamiento IDÉNTICOS a siempre.
 */
export function getAgentStub(env: Env, name: string) {
  const hint = parseLocationHint(env.AGENT_LOCATION_HINT);
  const saltedName = hint ? `${hint}:${name}` : name;
  const id = env.AGENT.idFromName(saltedName);
  return hint ? env.AGENT.get(id, { locationHint: hint }) : env.AGENT.get(id);
}

/**
 * Igual que `getAgentStub`, con channel/channelUserId SEPARADOS en vez de un
 * `name` ya combinado — la firma que espera `api-inbox.ts` (Forja Inbox,
 * porteado del paquete Forja+ v1.0.76, donde este módulo se llama
 * `agent-stub.ts`). Mismo id de conversación que `makeConvId` en
 * db/conversations.ts (`${channel}:${channelUserId}`), así que resuelve al
 * MISMO Durable Object que ya usa el resto del bot.
 */
export function agentStub(env: Env, channel: string, channelUserId: string) {
  return getAgentStub(env, `${channel}:${channelUserId}`);
}
