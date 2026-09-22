// Documentos comerciales compartibles: el bot los MANDA (PDF de precios,
// brochure, catálogo) en vez de solo citarlos como texto (eso es el KB —
// src/kb/docs.ts). El archivo binario vive en R2 (bucket CATALOG); esta repo
// solo administra su metadata en D1.
import { Db } from "./client";

export interface DocumentRow {
  id: string;
  title: string;
  description: string;
  filename: string;
  r2_key: string;
  mime_type: string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
}

export class DocumentsRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<DocumentRow[]> {
    return this.db.all<DocumentRow>("SELECT * FROM documents ORDER BY updated_at DESC");
  }

  async getById(id: string): Promise<DocumentRow | null> {
    return this.db.first<DocumentRow>("SELECT * FROM documents WHERE id = ?", [id]);
  }

  async upsert(doc: {
    id: string;
    title: string;
    description: string;
    filename: string;
    r2Key: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `INSERT INTO documents (id, title, description, filename, r2_key, mime_type, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, description = excluded.description, filename = excluded.filename,
         r2_key = excluded.r2_key, mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`,
      [doc.id, doc.title, doc.description, doc.filename, doc.r2Key, doc.mimeType, doc.sizeBytes, now, now],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run("DELETE FROM documents WHERE id = ?", [id]);
  }
}

/**
 * Quita acentos/diacríticos (mismo patrón que `fold()` en
 * src/time/resolveDate.ts y `normalizeForSpam()` en src/spam.ts — NFD +
 * despojar marcas combinantes). Hallazgo real (21-sep-2026): un documento
 * cargado con la descripción sin tildes ("cotizacion") no emparejaba con un
 * cliente que sí escribe bien el español ("cotización") — "distintos"
 * literalmente por el acento, aunque sea la misma palabra. Se aplica a la
 * query Y al título/descripción, así no importa de qué lado falta el acento.
 */
function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Empareja lo que pidió el cliente contra título/descripción de los
 * documentos disponibles. Igual de simple que catalogQuery (src/tools/
 * catalogQuery.ts): con el puñado de documentos que un negocio real comparte
 * (5-15), un match por palabras alcanza — no vale la pena un índice
 * vectorial para esto.
 */
export function matchDocument(query: string, docs: DocumentRow[]): DocumentRow | null {
  const q = foldAccents(query.toLowerCase().trim());
  if (!q) return null;
  const haystack = (d: DocumentRow) => foldAccents(`${d.title} ${d.description}`.toLowerCase());

  const exact = docs.find((d) => haystack(d).includes(q));
  if (exact) return exact;

  // Match por PALABRA COMPLETA, no substring — un `.includes(w)` ingenuo hace
  // que "que" (parte de la query "algo que no existe") empareje "paQUEtes"
  // por accidente. Tokenizar y comparar contra el set de palabras evita eso.
  // (Ya sin acentos a esta altura — el rango solo necesita a-z0-9.)
  const tokenize = (s: string): Set<string> => new Set(s.split(/[^a-z0-9]+/i).filter(Boolean));
  const words = tokenize(q);
  for (const w of [...words]) if (w.length <= 2) words.delete(w);
  if (words.size === 0) return null;

  const byWord = docs.find((d) => {
    const tokens = tokenize(haystack(d));
    return [...words].some((w) => tokens.has(w));
  });
  return byWord ?? null;
}
