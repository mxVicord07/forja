// Tab "Bóveda" — imágenes/audios/documentos que los CLIENTES mandaron al bot
// (superpoder Forja+ Pro, opt-in, skill /boveda). Distinto de "Documentos"
// (documentos.ts): ahí el dueño sube archivos que el bot MANDA; acá se
// archiva lo que el bot RECIBE (las URLs de los proveedores expiran — sin
// esto, esa foto de cotización se perdía en cuanto WhatsApp la borraba).
import type { Env } from "../../env";
import { Db } from "../../db/client";
import { ensureMediaTable, type MediaRow, type MediaKind } from "../../media/boveda";
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

function fmtSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ICON_BY_KIND: Record<MediaKind, string> = {
  image: "image",
  audio: "mic",
  document: "file-text",
};

interface MediaListRow extends MediaRow {
  display_name: string | null;
  channel: string | null;
}

const LIST_LIMIT = 60;

export async function renderBovedaList(env: Env): Promise<string> {
  const db = new Db(env.DB);
  await ensureMediaTable(db);
  const rows = await db.all<MediaListRow>(
    `SELECT m.*, c.display_name, c.channel
       FROM media m
       LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE m.direction = 'in' OR m.direction IS NULL
      ORDER BY m.created_at DESC
      LIMIT ?`,
    [LIST_LIMIT],
  );

  const configured = !!env.MEDIA;

  const bannerHtml = !configured
    ? `<div style="border:1px solid var(--dim);background:var(--panel2);color:var(--muted);padding:10px 14px;font-size:12.5px;margin-bottom:16px">
         La Bóveda todavía no tiene su bucket R2 conectado — enciéndela con el skill <code>/boveda</code>.
       </div>`
    : "";

  const cards = rows.length
    ? rows
        .map((r) => {
          const isImage = r.kind === "image";
          const preview = isImage
            ? `<img src="/admin/media/${encodeURIComponent(r.id)}" loading="lazy" alt="${esc(r.filename ?? "imagen")}"
                    style="width:100%;height:140px;object-fit:cover;background:var(--bg)">`
            : `<div style="width:100%;height:140px;display:flex;align-items:center;justify-content:center;background:var(--bg)">
                 <i data-lucide="${ICON_BY_KIND[r.kind]}" width="32" height="32" class="text-dim"></i>
               </div>`;
          const who = r.display_name || r.channel || "Cliente";
          return `
      <a href="/admin/media/${encodeURIComponent(r.id)}" target="_blank" rel="noopener"
         class="bg-panel border border-line" style="display:block;overflow:hidden;text-decoration:none">
        ${preview}
        <div style="padding:10px 12px">
          <div class="font-display font-semibold text-[12px] text-cream" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(who)}</div>
          ${r.caption ? `<div class="text-dim text-[11px]" style="margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.caption)}</div>` : ""}
          <div class="text-dim text-[10.5px]" style="margin-top:4px">${ago(r.created_at)}${r.bytes ? " · " + fmtSize(r.bytes) : ""}</div>
        </div>
      </a>`;
        })
        .join("")
    : `<div class="text-dim text-[12.5px]" style="padding:40px 18px;text-align:center;grid-column:1/-1">
         ${configured ? "Aún no hay nada archivado — en cuanto un cliente mande una foto o un audio, aparece aquí." : "Sin bucket conectado, no hay nada que mostrar todavía."}
       </div>`;

  const body = `
    ${bannerHtml}
    <div style="margin-bottom:16px">
      <h2 class="font-display font-semibold text-[15px] text-cream">🗄️ Bóveda</h2>
      <p class="text-muted text-[12.5px]" style="margin-top:2px">Fotos, audios y documentos que tus clientes te mandaron por el bot — las últimas ${LIST_LIMIT}, más recientes primero. Las URLs de los proveedores expiran; esta es la copia que se queda.</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px">
      ${cards}
    </div>`;

  return layout({ title: "Bóveda", activeTab: "boveda", body, env });
}
