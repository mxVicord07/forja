import type { Env } from "../../env";
import { Db } from "../../db/client";
import { TicketsRepo } from "../../db/tickets";
import { AppointmentChangeRequestsRepo, type AppointmentChangeRequest } from "../../db/appointmentChangeRequests";
import { layout } from "./layout";

const STATUS_PILL: Record<string, string> = {
  open: "var(--bad)",
  in_progress: "var(--info)",
};

export async function renderTickets(env: Env, failedTicketId?: string): Promise<string> {
  const db = new Db(env.DB);
  const repo = new TicketsRepo(db);
  const changes = new AppointmentChangeRequestsRepo(db);
  const open = await repo.listOpen();

  // Cargamos la solicitud de cambio de los tickets que la traen: son los
  // únicos que se resuelven con Aprobar/Rechazar en vez de "Resolver".
  const changeById = new Map<number, AppointmentChangeRequest>();
  for (const t of open) {
    const crId = t.appointment_change_request_id;
    if (crId == null) continue;
    const cr = await changes.getById(crId);
    if (cr) changeById.set(crId, cr);
  }

  const list = open
    .map((t) => {
      const date = new Date(t.created_at).toLocaleString("es-MX");
      const pillColor = STATUS_PILL[t.status] ?? "var(--muted)";
      const cr = t.appointment_change_request_id != null
        ? changeById.get(t.appointment_change_request_id)
        : undefined;
      return `<div class="tkcard bg-panel border border-line" style="padding:16px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:${pillColor};border:1px solid ${pillColor};padding:1px 6px;flex:none">${t.status.toUpperCase()}</span>
            <span class="font-display font-semibold text-[13px] text-cream truncate">${escapeHtml(t.category)}</span>
          </div>
          <span class="text-dim text-[11px]" style="flex:none">${date}</span>
        </div>
        <p class="text-muted text-[12.5px] leading-relaxed" style="margin:0 0 12px">${escapeHtml(t.summary)}</p>
        ${cr ? changeActions(t.id, cr, t.id === failedTicketId) : resolveForm(t.id)}
      </div>`;
    })
    .join("");

  const body =
    open.length === 0
      ? `<div class="bg-panel border border-line" style="padding:40px 18px;text-align:center">
           <p class="text-dim text-[12.5px]">No hay tickets abiertos.</p>
         </div>`
      : list;

  return layout({ title: "Tickets", activeTab: "tickets", body, env });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Form clásico de los tickets normales: cerrar con el email de quien atendió. */
function resolveForm(ticketId: string): string {
  return `<form method="POST" action="/admin/tickets/${ticketId}/resolve" style="display:flex;gap:8px">
    <input name="resolved_by" placeholder="tu email" required
           style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 12px;font-size:12.5px;outline:none">
    <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer"
            style="background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:3px 3px 0 var(--linelit);padding:9px 16px">Resolver</button>
  </form>`;
}

/**
 * Ticket de agenda: aprobar ejecuta el cambio en Cal.com y le avisa al cliente;
 * rechazar lo deja como estaba y también le avisa (con la nota, si la hay).
 */
function changeActions(ticketId: string, cr: AppointmentChangeRequest, failed = false): string {
  const detalle =
    cr.kind === "reschedule"
      ? `Nuevo horario propuesto: <b class="text-cream">${escapeHtml(cr.proposed_start ?? "")}</b>`
      : `Solicitud de <b class="text-cream">cancelación</b>` +
        (cr.reason ? ` — motivo: ${escapeHtml(cr.reason)}` : "");
  return `<div style="border-top:1px solid var(--line);padding-top:12px">
    <p class="text-muted text-[12px]" style="margin:0 0 10px">${detalle}</p>
    ${failed ? `<p class="text-[11.5px]" style="color:var(--bad)">✗ No se pudo ejecutar el cambio en Cal.com — vuelve a intentar el clic.</p>` : ""}
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
      <form method="POST" action="/admin/tickets/${ticketId}/approve-change">
        <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer"
                style="background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:3px 3px 0 var(--linelit);padding:9px 16px">Aprobar</button>
      </form>
      <form method="POST" action="/admin/tickets/${ticketId}/reject-change" style="display:flex;gap:8px;flex:1;min-width:240px">
        <input name="note" placeholder="Nota para el cliente (opcional)"
               style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 12px;font-size:12.5px;outline:none">
        <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer"
                style="background:var(--panel2);border:1px solid var(--line);color:var(--cream);padding:9px 16px">Rechazar</button>
      </form>
    </div>
  </div>`;
}
