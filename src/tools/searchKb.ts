import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";

export interface SearchKbResult {
  title: string;
  content: string;
  score: number;
}

/**
 * `onResult` es opcional: el agente lo usa para capturar qué trajo la
 * búsqueda ESTE turno (Blindaje lo usa como fuente de verdad; el selector de
 * modelo revive el score real en vez de quedarse en el valor neutral fijo).
 * Nunca se llama si la búsqueda falla — solo en el camino feliz.
 */
export function searchKbTool(env: Env, onResult?: (results: SearchKbResult[]) => void) {
  return tool({
    description:
      "Busca en el knowledge base del negocio. Devuelve top-5 chunks con score 0-1. Si top-1 score < 0.7 no hay match útil — escala.",
    inputSchema: z.object({
      query: z.string().min(2).describe("Pregunta o tema a buscar"),
    }),
    execute: async ({ query }) => {
      try {
        const embedding = await env.AI.run("@cf/baai/bge-m3", {
          text: query,
        });
        const vec = (embedding as any).data?.[0];
        if (!Array.isArray(vec)) {
          return { error: "transient" as const, message: "embedding shape unexpected" };
        }
        const matches = await env.KB.query(vec, { topK: 5 });
        const results: SearchKbResult[] = (matches.matches ?? []).map((m: any) => ({
          title: (m.metadata?.title as string) ?? "",
          content: (m.metadata?.content as string) ?? "",
          score: m.score ?? 0,
        }));
        onResult?.(results);
        return { results };
      } catch (e: any) {
        return { error: "transient" as const, message: String(e?.message ?? e) };
      }
    },
  });
}
