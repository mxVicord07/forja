/**
 * Bloque «Seguimiento en Odoo» de la pantalla de Leads: lectura en vivo, sin
 * copia local y sin botón de sincronizar (Odoo es el dueño del dato).
 * Devuelve "" si el bot no está conectado al CRM.
 */
import type { Env } from "../../env";
import { fetchSeguimiento, type FilaSeguimiento, type Seguimiento } from "../../crm/seguimiento";
import { calcomTimeZone } from "../../integrations/calcom";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const pesos = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const MAX_FILAS = 60;

export async function renderSeguimientoBlock(env: Env, ahora: Date = new Date()): Promise<string> {
  if (!env.CRM_SEGUIMIENTO_URL) return "";
  const r = await fetchSeguimiento(env);
  if (!r.ok) {
    return `<div class="bg-panel border border-line" style="padding:14px 18px;margin-bottom:22px">
      <span class="text-[12px]" style="color:var(--bad)">No se pudo leer el seguimiento de Odoo (${esc(r.reason)}). Los datos de abajo son solo los del asistente.</span></div>`;
  }
  return bloque(r.data, calcomTimeZone(env), ahora);
}

function bloque(d: Seguimiento, tz: string, ahora: Date): string {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
  const hora = new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ahora);
  const fechaCorta = (iso: string | null) => {
    if (!iso) return "—";
    const t = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
    return Number.isNaN(t.getTime()) ? "—" : new Intl.DateTimeFormat("es-MX", { timeZone: tz, day: "numeric", month: "short" }).format(t);
  };
  const chip = (titulo: string, valor: string, color = "var(--cream)") =>
    `<div class="border border-line" style="padding:8px 12px;min-width:104px"><div class="text-dim" style="font-size:9.5px;letter-spacing:.12em;text-transform:uppercase">${esc(titulo)}</div><div class="font-display font-semibold" style="font-size:15px;color:${color}">${esc(valor)}</div></div>`;

  const etapas = d.resumen.etapas.map((e) => chip(e.etapa, `${e.cuenta}${e.monto ? " · " + pesos(e.monto) : ""}`)).join("");
  const alertas = [
    chip("Prospectos", String(d.resumen.prospectos)),
    chip("Escribir hoy", String(d.resumen.tocarHoy), d.resumen.tocarHoy ? "var(--accent)" : "var(--cream)"),
    chip("Sin siguiente paso", String(d.resumen.sinActividad), d.resumen.sinActividad ? "var(--bad)" : "var(--cream)"),
    chip("Actividades vencidas", String(d.resumen.actividadVencida), d.resumen.actividadVencida ? "var(--bad)" : "var(--cream)"),
  ].join("");

  const boton = (href: string, texto: string, primario = false) =>
    `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="font-size:11.5px;padding:5px 10px;border:1px solid ${primario ? "var(--accent)" : "var(--line)"};background:${primario ? "var(--accent)" : "transparent"};color:${primario ? "#ffffff" : "var(--muted)"};text-decoration:none;white-space:nowrap">${texto}</a>`;

  const paraHoy = d.filas.filter((f) => f.sugerido).map((f) => {
    const s = f.sugerido!;
    const accion = s.permitido && s.waUrl
      ? boton(s.waUrl, "Enviar desde mi WhatsApp", true)
      : `<span class="text-[11.5px]" style="color:var(--bad)">${esc(s.motivo ?? "Sin permiso para escribirle por WhatsApp")}</span>`;
    return `<div class="border border-line" style="padding:12px 14px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div class="text-cream text-[13px] font-semibold">${esc(f.quien || f.titulo)} <span class="text-dim" style="font-weight:400">· ${esc(f.etapa ?? f.tipo)}</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${accion}${f.url ? boton(f.url, "Odoo") : ""}</div>
      </div>
      <div class="text-muted text-[12.5px]" style="margin-top:6px;white-space:pre-wrap;line-height:1.5">${esc(s.texto)}</div>
    </div>`;
  }).join("");

  const fila = (f: FilaSeguimiento) => {
    const vencida = f.actividad && f.actividad.fecha < hoy;
    const act = f.actividad
      ? `<span style="color:${vencida ? "var(--bad)" : "inherit"}">${esc(fechaCorta(f.actividad.fecha))}${f.actividad.resumen ? " · " + esc(f.actividad.resumen) : ""}</span>`
      : f.tipo === "oportunidad" ? `<span style="color:var(--bad)">Sin siguiente paso</span>` : "—";
    const links = [
      f.waPropio ? boton(f.waPropio, "WhatsApp") : "",
      f.conversacion ? `<a href="/admin/conversations?c=${encodeURIComponent(f.conversacion)}" style="font-size:11.5px;padding:5px 10px;border:1px solid var(--line);color:var(--muted);text-decoration:none">Chat</a>` : "",
      f.url ? boton(f.url, "Odoo") : "",
    ].join("");
    return `<div style="display:grid;grid-template-columns:minmax(150px,1.3fr) 110px minmax(160px,1.5fr) 70px minmax(140px,1.2fr) 70px auto;gap:10px;padding:10px 18px;font-size:12px;align-items:center;border-top:1px solid var(--line)">
      <div style="min-width:0"><div class="text-cream truncate">${esc(f.quien || "(sin nombre)")}</div><div class="text-dim truncate" style="font-size:11px">${esc(f.titulo)}${f.monto ? " · " + pesos(f.monto) : ""}</div></div>
      <span class="text-muted truncate">${esc(f.etapa ?? "Prospecto")}</span>
      <span class="text-muted truncate" title="${esc(f.semaforo ?? "")}">${esc(f.semaforo ?? "—")}</span>
      <span class="text-dim">${esc(fechaCorta(f.ultimoContacto))}</span>
      <span class="text-muted truncate">${act}</span>
      <span class="text-dim">${esc(fechaCorta(f.proximaCita))}</span>
      <div style="display:flex;gap:6px;justify-content:flex-end">${links}</div>
    </div>`;
  };
  const cabecera = `<div style="display:grid;grid-template-columns:minmax(150px,1.3fr) 110px minmax(160px,1.5fr) 70px minmax(140px,1.2fr) 70px auto;gap:10px;padding:9px 18px;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">
    <span>Quién</span><span>Etapa</span><span>Semáforo</span><span>Último</span><span>Siguiente paso</span><span>Cita</span><span></span></div>`;
  const tabla = (filas: FilaSeguimiento[]) => {
    const visibles = filas.slice(0, MAX_FILAS);
    const resto = filas.length - visibles.length;
    return `<div class="bg-panel border border-line" style="overflow-x:auto"><div style="min-width:900px">${cabecera}${visibles.map(fila).join("")}
      ${resto > 0 ? `<div class="text-dim text-[11.5px]" style="padding:10px 18px;border-top:1px solid var(--line)">+${resto} más en Odoo</div>` : ""}</div></div>`;
  };
  const opps = d.filas.filter((f) => f.tipo === "oportunidad");
  const pros = d.filas.filter((f) => f.tipo === "prospecto");

  return `<div style="margin-bottom:28px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap">
      <h2 class="font-display font-semibold text-[15px] text-cream">Seguimiento en Odoo</h2>
      <span class="text-dim text-[11px]">En vivo · leído a las ${esc(hora)}. Aquí no se edita: los cambios se hacen en Odoo o con el Copiloto.</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${etapas}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">${alertas}</div>
    ${d.aviso ? `<p class="text-[11.5px]" style="color:var(--bad);margin:0 0 10px">${esc(d.aviso)}</p>` : ""}
    ${paraHoy ? `<div class="text-dim" style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:8px">Mensajes sugeridos para hoy</div>${paraHoy}<div style="height:10px"></div>` : ""}
    <div class="text-dim" style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:8px">Oportunidades (${opps.length})</div>
    ${opps.length ? tabla(opps) : `<p class="text-dim text-[12px]">Sin oportunidades abiertas.</p>`}
    <details style="margin-top:14px"><summary class="text-dim" style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;cursor:pointer">Prospectos por calificar (${pros.length})</summary>
      <div style="margin-top:8px">${pros.length ? tabla(pros) : `<p class="text-dim text-[12px]">Sin prospectos.</p>`}</div></details>
  </div>`;
}
