// Sirve un documento comercial vía la URL pública firmada (/files/:id). Este
// es el "GET" que corresponde a signedFileUrl() en share.ts: valida la firma,
// resuelve la metadata en D1 (nunca confía en un r2_key que llegue de fuera —
// solo el id, que se cruza contra la tabla `documents`) y transmite el
// objeto desde R2.
import type { Env } from "../env";
import { Db } from "../db/client";
import { DocumentsRepo } from "../db/documents";
import { verifyFileUrl } from "./share";

export async function serveDocument(
  docId: string,
  exp: string | null,
  sig: string | null,
  env: Env,
): Promise<Response> {
  if (!(await verifyFileUrl(docId, exp, sig, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const doc = await new DocumentsRepo(new Db(env.DB)).getById(docId);
  if (!doc) return new Response("not found", { status: 404 });
  const obj = await env.CATALOG.get(doc.r2_key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": doc.mime_type,
      "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=1800",
    },
  });
}
