import type { Env } from "../../env";
import { layout } from "./layout";
import { cargarCitas } from "../../agenda/load";
import { calcomTimeZone } from "../../integrations/calcom";
import { rangoCitas, filtrarCitas, RANGOS, type CitaPanel, type EstadoCita, type ClaveRango } from "../../agenda/source";
import {
  parseDia, rangoCalendario, navegarCalendario, agruparPorDia, type Dia, type VistaCalendario,
} from "../../agenda/calendario";

const ETIQUETA_RANGO: Record<ClaveRango, string> = {
  proximas: "Próximos 14 días",
  hoy: "Hoy",
  "7d": "7 días",
  "30d": "30 días",
  pasadas: "Últimos 30 días",
};

const ETIQUETA_ESTADO: Record<EstadoCita, { texto: string; color: string }> = {
  confirmada: { texto: "Confirmada", color: "var(--ok, #2f855a)" },
  por_confirmar: { texto: "Por confirmar", color: "var(--info)" },
  cambio_pendiente: { texto: "Cambio pendiente", color: "var(--bad)" },
  cancelada: { texto: "Cancelada", color: "var(--muted)" },
};

const ETIQUETA_ORIGEN = { lia: "Asistente", reserva: "Enlace de reserva", odoo: "Calendario" } as const;
const mayuscula = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

/** Nombre para mostrar: si el contacto no tiene nombre o su «nombre» es un correo (pasa en Odoo), se usa el título de la cita. */
export function nombreVisible(c: CitaPanel): string {
  const n = c.persona.nombre.trim();
  if (n && !n.includes("@")) return n;
  return c.titulo.trim() || n || c.persona.correo || "Sin nombre";
}
const DIAS_CORTOS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const MAX_EN_CELDA_MES = 3;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Solo http(s): un enlace de ubicación que no lo sea no se vuelve href. */
const hrefSeguro = (u: string | null) => (u && /^https?:\/\//i.test(u) ? esc(u) : null);

export interface FiltrosCitas {
  /** `lista` (por omisión), `semana` o `mes`. */
  vista?: string;
  /** Día de referencia del calendario (`YYYY-MM-DD`); por omisión, hoy. */
  ref?: string;
  rango?: string;
  estado?: string;
  q?: string;
}

export async function renderCitas(env: Env, f: FiltrosCitas = {}, ahora: Date = new Date()): Promise<string> {
  const tz = calcomTimeZone(env);
  const vista: "lista" | VistaCalendario = f.vista === "semana" || f.vista === "mes" ? f.vista : "lista";
  const estado = f.estado && f.estado in ETIQUETA_ESTADO ? f.estado : "";
  const q = (f.q ?? "").slice(0, 80);

  const hoyClave = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
  const hoy = parseDia(hoyClave) as Dia;
  const ref = parseDia(f.ref) ?? hoy;

  const cal = vista === "lista" ? null : rangoCalendario(vista, ref, tz);
  const rango = cal ? { clave: "proximas" as ClaveRango, desde: cal.desde, hasta: cal.hasta } : rangoCitas(f.rango ?? "", ahora, tz);

  const cargadas = await cargarCitas(env, rango);
  let citas = filtrarCitas(cargadas.citas, { estado, q });
  if (!cal && rango.clave === "pasadas") citas = [...citas].reverse();

  const fmtHora = (iso: string) =>
    new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  const href = (over: { vista?: string; ref?: string; rango?: string }) => {
    const p = new URLSearchParams();
    const v = over.vista ?? vista;
    if (v !== "lista") p.set("vista", v);
    if (v !== "lista") {
      const r = over.ref ?? (f.ref && parseDia(f.ref) ? f.ref : "");
      if (r) p.set("ref", r);
    } else {
      const r = over.rango ?? rango.clave;
      if (r !== "proximas") p.set("rango", r);
    }
    if (estado) p.set("estado", estado);
    if (q) p.set("q", q);
    const s = p.toString();
    return "/admin/citas" + (s ? "?" + s : "");
  };

  const tab = (v: "lista" | "semana" | "mes", texto: string) => {
    const activo = v === vista;
    return `<a href="${href({ vista: v, ref: "" })}" style="padding:6px 14px;font-size:12px;border:1px solid ${activo ? "var(--accent)" : "var(--line)"};background:${activo ? "var(--accent)" : "transparent"};color:${activo ? "#ffffff" : "var(--muted)"};text-decoration:none">${texto}</a>`;
  };
  const tabs = `<div style="display:flex;gap:6px;margin-bottom:12px">${tab("lista", "Lista")}${tab("semana", "Semana")}${tab("mes", "Mes")}</div>`;

  const opcionesEstado = [["", "Todos los estados"], ...Object.entries(ETIQUETA_ESTADO).map(([k, v]) => [k, v.texto])]
    .map(([k, t]) => `<option value="${k}" ${k === estado ? "selected" : ""}>${esc(t)}</option>`)
    .join("");
  const ocultos =
    (vista !== "lista" ? `<input type="hidden" name="vista" value="${vista}">${f.ref && parseDia(f.ref) ? `<input type="hidden" name="ref" value="${esc(f.ref)}">` : ""}` : "") +
    (vista === "lista" && rango.clave !== "proximas" ? `<input type="hidden" name="rango" value="${rango.clave}">` : "");
  const filtros = `<form method="GET" action="/admin/citas" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0 20px">
    ${ocultos}
    <select name="estado" onchange="this.form.submit()" style="background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:7px 10px;font-size:12px">${opcionesEstado}</select>
    <input name="q" value="${esc(q)}" placeholder="Buscar por nombre o correo" style="flex:1;min-width:200px;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:7px 10px;font-size:12px;outline:none">
    <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer" style="background:var(--panel2);border:1px solid var(--line);color:var(--cream);padding:7px 14px">Buscar</button>
  </form>`;

  const hora = `${esc(fmtHora(ahora.toISOString()))} (${esc(tz)})`;
  const fuente =
    cargadas.fuente === "odoo"
      ? `Fuente: calendario de Odoo (Outlook, Copiloto y Cal.com) · ${hora}`
      : cargadas.fuente === "calcom"
        ? `Fuente: solo reservas de Cal.com · ${hora}${env.CRM_AGENDA_URL ? "" : ". Las reuniones creadas en Outlook o con el Copiloto no aparecen hasta conectar Odoo"}`
        : `Fuente: citas del asistente`;
  const aviso = cargadas.aviso
    ? `<p class="text-[11.5px]" style="color:var(--bad);margin:0 0 12px">${esc(cargadas.aviso)}</p>`
    : "";
  const comoMover = cargadas.fuente === "odoo"
    ? "Para mover o cancelar, usa el Copiloto (/agenda) u Outlook; si la agendó el asistente, Tickets."
    : "Para mover o cancelar una cita, usa Tickets.";
  const pie = `<p class="text-dim text-[11px]" style="margin:0 0 16px">${fuente}. ${comoMover}</p>`;

  const pildoras = RANGOS.map((r) => {
    const activo = r === rango.clave;
    return `<a href="${href({ rango: r })}" style="padding:6px 12px;font-size:11.5px;border:1px solid ${activo ? "var(--accent)" : "var(--line)"};color:${activo ? "var(--accent)" : "var(--muted)"};text-decoration:none">${ETIQUETA_RANGO[r]}</a>`;
  }).join("");
  const barraRango = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${pildoras}</div>`;

  let contenido: string;
  if (cal) {
    const grupos = agruparPorDia(citas, tz);
    const navLink = (dir: -1 | 1, texto: string) =>
      `<a href="${href({ ref: navegarCalendario(vista as VistaCalendario, ref, dir) })}" style="padding:5px 12px;font-size:12px;border:1px solid var(--line);color:var(--muted);text-decoration:none">${texto}</a>`;
    const nav = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      ${navLink(-1, "← Anterior")}
      <a href="${href({ ref: "" })}" style="padding:5px 12px;font-size:12px;border:1px solid var(--line);color:var(--muted);text-decoration:none">Hoy</a>
      ${navLink(1, "Siguiente →")}
      <span class="font-display font-semibold text-[14px] text-cream" style="margin-left:6px">${esc(mayuscula(cal.titulo))}</span>
    </div>`;
    contenido = nav + rejilla(vista as VistaCalendario, cal.celdas, grupos, hoyClave, fmtHora);
  } else if (citas.length === 0) {
    contenido = `${barraRango}<div class="bg-panel border border-line" style="padding:40px 18px;text-align:center">
      <p class="text-dim text-[12.5px]">No hay citas en este rango.</p></div>`;
  } else {
    const fmtDia = (iso: string) =>
      new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
    const lista = [...agruparPorDia(citas, tz).values()]
      .map((delDia) => `<div style="margin-bottom:22px">
        <div class="text-dim" style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:8px">${esc(fmtDia(delDia[0].inicio))}</div>
        ${delDia.map((c) => renglon(c, fmtHora)).join("")}
      </div>`)
      .join("");
    contenido = barraRango + lista;
  }

  const body = `${tabs}${filtros}${aviso}${pie}${contenido}`;
  return layout({ title: "Citas", activeTab: "citas", body, env });
}

/** Rejilla de semana (todas las citas del día) o de mes (hasta 3 por día y «+N más»). */
function rejilla(
  vista: VistaCalendario,
  celdas: { clave: string; dia: number; delMes: boolean }[],
  grupos: Map<string, CitaPanel[]>,
  hoyClave: string,
  fmtHora: (iso: string) => string,
): string {
  const maxVisibles = vista === "mes" ? MAX_EN_CELDA_MES : 50;
  const cabecera = DIAS_CORTOS.map(
    (d) => `<div class="text-dim" style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:6px 8px">${d}</div>`,
  ).join("");
  const filas = celdas
    .map((c) => {
      const delDia = grupos.get(c.clave) ?? [];
      const visibles = delDia.slice(0, maxVisibles);
      const resto = delDia.length - visibles.length;
      const esHoy = c.clave === hoyClave;
      const items = visibles
        .map((x) => {
          const est = ETIQUETA_ESTADO[x.estado];
          const tachado = x.estado === "cancelada" ? "text-decoration:line-through;opacity:.65;" : "";
          const url = x.estado === "cancelada" ? null : hrefSeguro(x.enlace);
          const nombre = esc(x.privado ? "Ocupado" : nombreVisible(x));
          const etiqueta = `<span style="color:${est.color};font-weight:600">${esc(fmtHora(x.inicio))}</span> ${nombre}`;
          const titulo = esc(`${est.texto} · ${ETIQUETA_ORIGEN[x.origen]}${x.titulo ? " · " + x.titulo : ""}`);
          const opp = x.oportunidad ? hrefSeguro(x.oportunidad.url) : null;
          const inner = x.privado
            ? `<span title="Ocupado">${etiqueta}</span>`
            : x.conversacion
            ? `<a href="/admin/conversations?c=${encodeURIComponent(x.conversacion)}" title="${titulo}" style="color:inherit;text-decoration:none">${etiqueta}</a>`
            : opp
              ? `<a href="${opp}" target="_blank" rel="noopener noreferrer" title="${titulo}" style="color:inherit;text-decoration:none">${etiqueta}</a>`
              : url
              ? `<a href="${url}" target="_blank" rel="noopener noreferrer" title="${titulo}" style="color:inherit;text-decoration:none">${etiqueta}</a>`
              : `<span title="${titulo}">${etiqueta}</span>`;
          return `<div class="text-[11.5px] text-cream" style="padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${tachado}">${inner}</div>`;
        })
        .join("");
      const mas = resto > 0 ? `<div class="text-dim text-[11px]">+${resto} más</div>` : "";
      const alto = vista === "mes" ? "min-height:92px" : "min-height:160px";
      const fondo = esHoy ? "background:var(--panel2);" : "";
      const opaco = c.delMes ? "" : "opacity:.5;";
      return `<div class="border border-line" style="padding:6px 8px;${alto};${fondo}${opaco}min-width:0">
        <div class="text-[11px] ${esHoy ? "text-cream font-semibold" : "text-dim"}" style="margin-bottom:4px">${c.dia}</div>
        ${items}${mas}
      </div>`;
    })
    .join("");
  return `<div style="overflow-x:auto"><div style="display:grid;grid-template-columns:repeat(7,minmax(110px,1fr));min-width:770px">${cabecera}${filas}</div></div>`;
}

function renglon(c: CitaPanel, fmtHora: (iso: string) => string): string {
  if (c.privado) {
    return `<div class="bg-panel border border-line" style="padding:12px 16px;margin-bottom:8px;display:flex;gap:16px;align-items:center">
    <div style="flex:none;min-width:84px"><div class="font-display font-semibold text-[15px] text-cream">${esc(fmtHora(c.inicio))}</div>
      <div class="text-dim text-[11px]">${c.duracionMin ? `${c.duracionMin} min` : ""}</div></div>
    <div class="text-dim text-[13px]">Ocupado</div>
  </div>`;
  }
  const est = ETIQUETA_ESTADO[c.estado];
  const dur = c.duracionMin ? `${c.duracionMin} min` : "";
  const contacto = [c.persona.correo, c.persona.telefono].filter(Boolean).map((x) => esc(x as string)).join(" · ");
  const url = c.estado === "cancelada" ? null : hrefSeguro(c.enlace);
  const opp = c.oportunidad ? hrefSeguro(c.oportunidad.url) : null;
  const acciones = [
    c.conversacion ? `<a href="/admin/conversations?c=${encodeURIComponent(c.conversacion)}" style="color:var(--accent);font-size:11.5px">Conversación</a>` : "",
    opp ? `<a href="${opp}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:11.5px">Oportunidad: ${esc(c.oportunidad!.nombre)}</a>` : "",
    url ? `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:11.5px">Reunión</a>` : "",
  ].filter(Boolean).join(" · ");
  const tachado = c.estado === "cancelada" ? "text-decoration:line-through;opacity:.7;" : "";
  return `<div class="bg-panel border border-line" style="padding:12px 16px;margin-bottom:8px;display:flex;gap:16px;align-items:flex-start;${tachado}">
    <div style="flex:none;min-width:84px">
      <div class="font-display font-semibold text-[15px] text-cream">${esc(fmtHora(c.inicio))}</div>
      <div class="text-dim text-[11px]">${esc(dur)}</div>
    </div>
    <div style="flex:1;min-width:0">
      <div class="text-cream text-[13px] font-semibold truncate">${esc(nombreVisible(c))}</div>
      ${c.titulo ? `<div class="text-muted text-[12px]">${esc(c.titulo)}</div>` : ""}
      <div class="text-dim text-[11.5px]">${contacto}${c.lugar ? ` · ${esc(c.lugar)}` : ""}</div>
      ${acciones ? `<div style="margin-top:6px">${acciones}</div>` : ""}
    </div>
    <div style="flex:none;text-align:right">
      <span style="font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:${est.color};border:1px solid ${est.color};padding:1px 6px">${est.texto}</span>
      <div class="text-dim text-[10.5px]" style="margin-top:6px">${ETIQUETA_ORIGEN[c.origen]}</div>
    </div>
  </div>`;
}
