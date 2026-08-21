// Tab "Documentos" — archivos comerciales (PDF de precios, brochures) que el
// bot puede MANDAR como adjunto cuando el cliente lo pide (shareDocument.ts).
// Distinto de "Conocimiento" (kb.ts): ahí el dueño escribe TEXTO que el bot
// cita; acá sube un ARCHIVO que el bot envía tal cual.
import type { Env } from "../../env";
import { Db } from "../../db/client";
import { DocumentsRepo, type DocumentRow } from "../../db/documents";
import { layout } from "./layout";

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

function ago(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function banner(tone: "ok" | "bad" | "neutral", text: string): string {
  const color = tone === "ok" ? "var(--ok)" : tone === "bad" ? "var(--bad)" : "var(--dim)";
  const bg = tone === "ok" ? "rgba(76,154,76,.1)" : tone === "bad" ? "rgba(196,86,63,.1)" : "var(--panel2)";
  return `<div style="border:1px solid ${color};background:${bg};color:${tone === "neutral" ? "var(--muted)" : color};padding:10px 14px;font-size:12.5px;margin-bottom:16px">${text}</div>`;
}

export async function renderDocumentosList(
  env: Env,
  flash?: { saved?: boolean; deleted?: boolean; error?: string },
): Promise<string> {
  const docs = await new DocumentsRepo(new Db(env.DB)).list();

  const bannerHtml = flash?.saved
    ? banner("ok", "✓ Documento subido — el bot ya puede compartirlo.")
    : flash?.deleted
      ? banner("neutral", "Documento eliminado.")
      : flash?.error
        ? banner("bad", esc(flash.error))
        : "";

  const rows = docs.length
    ? docs
        .map(
          (d) => `
      <div style="display:flex;align-items:center;gap:12px;padding:13px 18px;border-top:1px solid var(--line)">
        <i data-lucide="file-text" width="18" height="18" class="text-dim" style="flex:none"></i>
        <div style="min-width:0;flex:1">
          <div class="font-display font-semibold text-[13px] text-cream">${esc(d.title)}</div>
          <div class="text-dim text-[11.5px]" style="margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.description)}</div>
        </div>
        <div class="text-dim text-[10.5px]" style="text-align:right;white-space:nowrap;flex:none">
          <div>${esc(d.filename)} · ${fmtSize(d.size_bytes)}</div>
          <div>${ago(d.updated_at)}</div>
        </div>
        <form method="POST" action="/admin/documentos/${encodeURIComponent(d.id)}/delete" style="flex:none">
          <button type="submit" style="background:transparent;border:1px solid var(--bad);color:var(--bad);padding:5px 12px;font-size:11px;cursor:pointer">Eliminar</button>
        </form>
      </div>`,
        )
        .join("")
    : `<div class="text-dim text-[12.5px]" style="padding:40px 18px;text-align:center">
         Aún no subes ningún documento. Sube el primero — precios, catálogo, brochure…
       </div>`;

  const body = `
    ${bannerHtml}
    <div style="margin-bottom:16px">
      <h2 class="font-display font-semibold text-[15px] text-cream">📎 Documentos</h2>
      <p class="text-muted text-[12.5px]" style="margin-top:2px">Archivos que tu bot puede MANDAR al cliente cuando pida ver precios o un catálogo — no solo texto, el archivo real (PDF).</p>
    </div>

    <form method="POST" action="/admin/documentos/save" enctype="multipart/form-data"
          class="bg-panel border border-line" style="padding:22px;display:flex;flex-direction:column;gap:16px;margin-bottom:20px">
      <h3 class="font-display font-semibold text-[13px] text-cream">＋ Subir documento</h3>

      <div style="display:flex;flex-direction:column;gap:6px">
        <label for="title" class="font-display font-semibold text-[12.5px] text-cream">Título</label>
        <input type="text" id="title" name="title" required maxlength="200" placeholder="Ej. Paquetes de sitios web"
               style="background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:12.5px;outline:none">
      </div>

      <div style="display:flex;flex-direction:column;gap:6px">
        <label for="description" class="font-display font-semibold text-[12.5px] text-cream">Cuándo compartirlo</label>
        <p class="text-dim text-[11px]">Palabras que el cliente diría para pedirlo — el bot decide con esto. Ej. "precios de páginas web, paquetes, cotización de sitio".</p>
        <input type="text" id="description" name="description" required maxlength="300" placeholder="precios de páginas web, paquetes, cotización"
               style="background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:12.5px;outline:none">
      </div>

      <div style="display:flex;flex-direction:column;gap:6px">
        <label for="file" class="font-display font-semibold text-[12.5px] text-cream">Archivo (PDF, máx. 15 MB)</label>
        <input type="file" id="file" name="file" required accept="application/pdf"
               style="background:var(--bg);border:1px solid var(--line);color:var(--muted);padding:10px 12px;font-size:12.5px;outline:none">
      </div>

      <button type="submit" class="bigbtn font-display font-bold text-[12.5px] cursor-pointer"
              style="background:var(--accent);border:1px solid var(--accent);color:#ffffff;box-shadow:var(--shadow-card);padding:11px 20px;align-self:flex-start">Subir</button>
    </form>

    <div class="bg-panel border border-line" style="overflow:hidden">
      ${rows}
    </div>`;

  return layout({ title: "Documentos", activeTab: "documentos", body, env });
}
