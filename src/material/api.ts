// GET /material — la lista de piezas comerciales del panel «Documentos» con enlace
// firmado de 30 min, para que OTRO sistema (el Copiloto de Víctor en Telegram) se las
// mande a su dueño y él las reenvíe a mano a un contacto. Lía no usa esto: ella manda
// por `shareDocument`. Fuente única: el mismo panel, sin segunda copia.
//
// Seguridad: token propio (MATERIAL_TOKEN, secret de Cloudflare) comparado en tiempo
// constante. Sin token configurado o con token malo la respuesta es la misma 401 (no se
// le dice a quien llama que falta el secret). Nunca se expone la ruta interna de R2.
import { Db } from "../db/client";
import { DocumentsRepo } from "../db/documents";
import { signedFileUrl } from "../files/share";
import { tokensMatch } from "../http-auth";
import type { Env } from "../env";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function listarMaterial(provided: string, env: Env, origin = ""): Promise<Response> {
  const expected = env.MATERIAL_TOKEN ?? "";
  if (!expected || !provided || !tokensMatch(provided, expected)) {
    if (!expected) console.warn("material: MATERIAL_TOKEN no está configurado en este Worker; toda llamada devuelve unauthorized");
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const docs = await new DocumentsRepo(new Db(env.DB)).list();
  const out = [];
  for (const d of docs) {
    const url = await signedFileUrl(d.id, env, origin);
    if (!url) return json({ ok: false, error: "signing_unavailable" }, 500);
    out.push({
      id: d.id,
      title: d.title,
      description: d.description,
      kind: /^image\//i.test(d.mime_type) ? "imagen" : "pdf",
      mime_type: d.mime_type,
      size_kb: Math.round(d.size_bytes / 1024),
      url,
    });
  }
  return json({ ok: true, expires_in_min: 30, documents: out }, 200);
}
