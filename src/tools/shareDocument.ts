import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { DocumentsRepo, matchDocument, type DocumentRow } from "../db/documents";

/**
 * `onShare` es opcional, mismo patrón que `onSearchKb` (searchKb.ts): el
 * agente lo usa para capturar QUÉ documento hay que mandar este turno.
 * El envío real (bajar de R2, firmar URL, hablarle al canal) NO pasa aquí —
 * pasa DESPUÉS de que el texto de la respuesta ya salió (agent.ts), porque
 * el archivo debe llegar como un mensaje aparte, tras la explicación del
 * bot, no como parte del JSON que ve el modelo.
 */
export function shareDocumentTool(env: Env, onShare?: (doc: DocumentRow) => void) {
  return tool({
    description:
      "Comparte un documento comercial (PDF, brochure, tabla de precios) con el cliente cuando pida ver precios, paquetes, catálogo o cotización por escrito. Se manda como archivo adjunto, además de tu respuesta en texto.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe("qué documento busca el cliente, ej. 'paquetes de sitios web' o 'precios'"),
    }),
    execute: async ({ query }) => {
      try {
        const docs = await new DocumentsRepo(new Db(env.DB)).list();
        const match = matchDocument(query, docs);
        if (!match) return { found: false as const };
        onShare?.(match);
        return { found: true as const, title: match.title };
      } catch (e: any) {
        return { found: false as const, error: String(e?.message ?? e) };
      }
    },
  });
}
