/**
 * Extrae lo útil de un error del AI SDK (APICallError / NoOutputGeneratedError)
 * para los logs del Worker. El `message` solo suele decir "Bad Request"; el
 * body de OpenAI (schema inválido, etc.) vive en responseBody / cause.
 */
export function formatLlmError(e: unknown): string {
  if (e == null) return String(e);
  const err = e as Record<string, any>;
  const cause =
    err.cause && typeof err.cause === "object"
      ? (err.cause as Record<string, any>)
      : undefined;
  const parts: string[] = [];
  const msg = typeof err.message === "string" ? err.message : String(e);
  parts.push(msg);
  const status = err.statusCode ?? cause?.statusCode;
  if (status != null) parts.push(`status=${status}`);
  const url = err.url ?? cause?.url;
  if (typeof url === "string" && url) parts.push(`url=${url}`);
  const body = err.responseBody ?? err.data ?? cause?.responseBody ?? cause?.data;
  if (body != null) {
    const s = typeof body === "string" ? body : safeJson(body);
    if (s) parts.push(`body=${s.slice(0, 800)}`);
    else parts.push("body=<empty>");
  } else if (status === 400) {
    parts.push("body=<empty>");
  }
  const hdrs = err.responseHeaders ?? cause?.responseHeaders;
  if (hdrs && typeof hdrs === "object") {
    const interesting = ["server", "cf-ray", "cf-mitigated", "content-length", "content-type", "connection"];
    const bits: string[] = [];
    for (const k of interesting) {
      const v = headerGet(hdrs, k);
      if (v) bits.push(`${k}=${v}`);
    }
    if (bits.length) parts.push(`headers=${bits.join(" ")}`);
  }
  if (cause?.message && cause.message !== msg) {
    parts.push(`cause=${cause.message}`);
  }
  return parts.join(" | ");
}

function headerGet(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const rec = headers as Record<string, unknown>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct) && typeof direct[0] === "string") return direct[0];
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  return undefined;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 400 / "No output generated" — vale la pena reintentar el mismo modelo
 * sin SSE (generateText). Rate-limits y 5xx se dejan al failover de proveedor.
 */
export function isLikelyRequestOrStreamFailure(e: unknown): boolean {
  const err = e as Record<string, any> | undefined;
  if (!err) return false;
  const cause =
    err.cause && typeof err.cause === "object"
      ? (err.cause as Record<string, any>)
      : undefined;
  const status = err.statusCode ?? cause?.statusCode;
  if (status === 400) return true;
  const name = `${err.name ?? ""} ${cause?.name ?? ""}`;
  const msg = `${err.message ?? ""} ${cause?.message ?? ""}`;
  return /Bad Request|No output generated/i.test(`${name} ${msg}`);
}
