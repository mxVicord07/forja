/**
 * Worker egress helpers.
 *
 * Cloudflare Workers `fetch` does NOT add a User-Agent (workerd#4711). Many
 * WAFs — including Cloudflare in front of Anthropic and some channel APIs
 * (Zernio) — reject those requests at the edge with HTTP 400 and an empty
 * body (`content-length: 0`, `connection: close`) before the origin app sees
 * them. The same empty 400 happens when a header value contains CR/LF
 * (classic Windows Git Bash `wrangler secret put` leftover).
 *
 * Use `egressFetch` for every outbound call from the Worker/DO (LLM +
 * channels). Forja+ adapters (Zernio, …) should import this too.
 */

export const EGRESS_USER_AGENT = "ForjaBot/1.0 (+https://horizontesia.com)";

/** Hop-by-hop + spoofable CF headers. Destination edges often 400 these. */
const STRIP_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

const INTERESTING_RESPONSE_HEADERS = [
  "server",
  "cf-ray",
  "cf-mitigated",
  "content-type",
  "content-length",
  "connection",
  "request-id",
  "x-request-id",
];

/** Strip C0 controls (incl. CR/LF from Windows secrets) and trim. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

export function sanitizeHeaders(init?: HeadersInit): Headers {
  const out = new Headers();
  const src = new Headers(init ?? undefined);
  for (const [name, value] of src.entries()) {
    if (STRIP_HEADERS.has(name.toLowerCase())) continue;
    const clean = sanitizeHeaderValue(value);
    if (!clean) continue;
    out.set(name, clean);
  }
  if (!out.has("User-Agent")) out.set("User-Agent", EGRESS_USER_AGENT);
  return out;
}

function requestHost(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return new URL(input).host;
    if (input instanceof URL) return input.host;
    if (input instanceof Request) return new URL(input.url).host;
  } catch {
    /* ignore */
  }
  return "?";
}

export function summarizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of INTERESTING_RESPONSE_HEADERS) {
    const v = headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

/**
 * Same contract as global `fetch`, with sanitized headers + a real User-Agent.
 * Logs empty 400s with response headers so `wrangler tail` can tell WAF/edge
 * rejection from a real provider JSON error.
 */
export async function egressFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = sanitizeHeaders(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const res = await fetch(input, { ...init, headers });
  const len = res.headers.get("content-length");
  if (res.status === 400 && (len === "0" || len === null)) {
    const meta = Object.entries(summarizeResponseHeaders(res.headers))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.error(
      `[egress] 400 empty-body host=${requestHost(input)} ${meta || "(no diagnostic headers)"} — likely edge/WAF, not the origin app`,
    );
  }
  return res;
}

export interface EgressProbeResult {
  url: string;
  status: number;
  contentLength: string | null;
  bodyChars: number;
  bodyPreview: string;
  headers: Record<string, string>;
  /** false = empty 400, the ticket-7E5F40 signature (cut before origin). */
  reachedOriginLikely: boolean;
}

/** GET a provider `/v1/messages` URL. No API key — only tests Worker egress. */
export async function probeMessagesEndpoint(baseURL: string): Promise<EgressProbeResult> {
  const url = `${baseURL.replace(/\/+$/, "")}/v1/messages`;
  const res = await egressFetch(url, { method: "GET" });
  const body = await res.text();
  return {
    url,
    status: res.status,
    contentLength: res.headers.get("content-length"),
    bodyChars: body.length,
    bodyPreview: body.slice(0, 180),
    headers: summarizeResponseHeaders(res.headers),
    reachedOriginLikely: !(res.status === 400 && body.length === 0),
  };
}
