import type { Env } from "../../env";
import { layout } from "./layout";
import { cargarCitas } from "../../agenda/load";
import { calcomTimeZone } from "../../integrations/calcom";
import { rangoCitas, filtrarCitas, RANGOS, type CitaPanel, type EstadoCita, type ClaveRango } from "../../agenda/source";

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

const ETIQUETA_ORIGEN = { lia: "Asistente", reserva: "Enlace de reserva" } as const;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Solo http(s): un enlace de ubicación que no lo sea no se vuelve href. */
const hrefSeguro = (u: string | null) => (u && /^https?:\/\//i.test(u) ? esc(u) : null);

export interface FiltrosCitas {
  rango?: string;
  estado?: string;
  q?: string;
}

export async function renderCitas(env: Env, f: FiltrosCitas = {}, ahora: Date = new Date()): Promise<string> {
  const tz = calcomTimeZone(env);
  const rango = rangoCitas(f.rango ?? "", ahora, tz);
  const estado = f.estado && f.estado in ETIQUETA_ESTADO ? f.estado : "";
  const q = (f.q ?? "").slice(0, 80);

  const cargadas = await cargarCitas(env, rango);
  let citas = filtrarCitas(cargadas.citas, { estado, q });
  if (rango.clave === "pasadas") citas = [...citas].reverse();

  const fmtDia = (iso: string) =>
    new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
  const fmtHora = (iso: string) =>
    new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const claveDia = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

  const grupos = new Map<string, CitaPanel[]>();
  for (const c of citas) {
    const k = claveDia(c.inicio);
    grupos.set(k, [...(grupos.get(k) ?? []), c]);
  }

  const lista = [...grupos.values()]
    .map((delDia) => {
      const filas = delDia.map((c) => renglon(c, fmtHora)).join("");
      return `<div style="margin-bottom:22px">
        <div class="text-dim" style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:8px">${esc(fmtDia(delDia[0].inicio))}</div>
        ${filas}
      </div>`;
    })
    .join("");

  const vacio = `<div class="bg-panel border border-line" style="padding:40px 18px;text-align:center">
    <p class="text-dim text-[12.5px]">No hay citas en este rango.</p></div>`;

  const href = (over: FiltrosCitas) => {
    const p = new URLSearchParams();
    const r = over.rango ?? rango.clave;
    if (r !== "proximas") p.set("rango", r);
    const e = over.estado ?? estado;
    if (e) p.set("estado", e);
    const qq = over.q ?? q;
    if (qq) p.set("q", qq);
    const s = p.toString();
    return "/admin/citas" + (s ? "?" + s : "");
  };

  const pildoras = RANGOS.map((r) => {
    const activo = r === rango.clave;
    return `<a href="${href({ rango: r })}" style="padding:6px 12px;font-size:11.5px;border:1px solid ${activo ? "var(--accent)" : "var(--line)"};color:${activo ? "var(--accent)" : "var(--muted)"};text-decoration:none">${ETIQUETA_RANGO[r]}</a>`;
  }).join("");

  const opcionesEstado = [["", "Todos los estados"], ...Object.entries(ETIQUETA_ESTADO).map(([k, v]) => [k, v.texto])]
    .map(([k, t]) => `<option value="${k}" ${k === estado ? "selected" : ""}>${esc(t)}</option>`)
    .join("");

  const filtros = `<form method="GET" action="/admin/citas" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0 20px">
    ${rango.clave !== "proximas" ? `<input type="hidden" name="rango" value="${rango.clave}">` : ""}
    <select name="estado" onchange="this.form.submit()" style="background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:7px 10px;font-size:12px">${opcionesEstado}</select>
    <input name="q" value="${esc(q)}" placeholder="Buscar por nombre o correo" style="flex:1;min-width:200px;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:7px 10px;font-size:12px;outline:none">
    <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer" style="background:var(--panel2);border:1px solid var(--line);color:var(--cream);padding:7px 14px">Buscar</button>
  </form>`;

  const fuente =
    cargadas.fuente === "calcom"
      ? `Fuente: Cal.com · ${esc(new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ahora))} (${esc(tz)})`
      : `Fuente: citas del asistente`;
  const aviso = cargadas.aviso
    ? `<p class="text-[11.5px]" style="color:var(--bad);margin:0 0 12px">${esc(cargadas.aviso)}</p>`
    : "";

  const body = `<div style="display:flex;gap:6px;flex-wrap:wrap">${pildoras}</div>
    ${filtros}
    ${aviso}
    <p class="text-dim text-[11px]" style="margin:0 0 16px">${fuente}. Para mover o cancelar una cita, usa Tickets.</p>
    ${citas.length ? lista : vacio}`;

  return layout({ title: "Citas", activeTab: "citas", body, env });
}

function renglon(c: CitaPanel, fmtHora: (iso: string) => string): string {
  const est = ETIQUETA_ESTADO[c.estado];
  const dur = c.duracionMin ? ` · ${c.duracionMin} min` : "";
  const contacto = [c.persona.correo, c.persona.telefono].filter(Boolean).map((x) => esc(x as string)).join(" · ");
  const url = hrefSeguro(c.enlace);
  const acciones = [
    c.conversacion ? `<a href="/admin/conversations?c=${encodeURIComponent(c.conversacion)}" style="color:var(--accent);font-size:11.5px">Conversación</a>` : "",
    url ? `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:11.5px">Reunión</a>` : "",
  ].filter(Boolean).join(" · ");
  const tachado = c.estado === "cancelada" ? "text-decoration:line-through;opacity:.7;" : "";
  return `<div class="bg-panel border border-line" style="padding:12px 16px;margin-bottom:8px;display:flex;gap:16px;align-items:flex-start;${tachado}">
    <div style="flex:none;min-width:84px">
      <div class="font-display font-semibold text-[15px] text-cream">${esc(fmtHora(c.inicio))}</div>
      <div class="text-dim text-[11px]">${esc(dur.replace(/^ · /, ""))}</div>
    </div>
    <div style="flex:1;min-width:0">
      <div class="text-cream text-[13px] font-semibold truncate">${esc(c.persona.nombre || "Sin nombre")}</div>
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
