/**
 * Plantillas de WhatsApp (13-nov-2026; idea tomada de Forja+ v1.0.51, hecha a la medida de este fork).
 *
 * Forja+ solo pide nombre e idioma. Aquí se LISTAN las plantillas aprobadas de la
 * cuenta (YCloud hoy; Twilio si así está conectado) y se asignan con un clic a cada
 * función: reactivar leads fríos y recordatorio de cita. La asignación vive en la
 * configuración del bot (lib/plantillasRoles.ts) con las variables de entorno de
 * respaldo. Las plantillas se crean y aprueban en WhatsApp Manager / YCloud; aquí no.
 */
import type { Env } from "../../env";
import { layout } from "./layout";
import { listContentTemplates, parseYcSid, campanasPorPlantillaBloqueadas, type ContentTemplate } from "../../campaigns";
import { ROLES, PISTA, esAvisoInterno, plantillaDe, type RolPlantilla } from "../../lib/plantillasRoles";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function proveedor(env: Env): string {
  if ((env.WA_PROVIDER ?? "") === "ycloud" || env.YCLOUD_API_KEY) return "YCloud";
  if (env.WHATSAPP_PHONE_NUMBER_ID) return "API de WhatsApp de Meta";
  if (env.TWILIO_ACCOUNT_SID) return "Twilio";
  return "";
}

/** Nombre e idioma de una plantilla listada (YCloud trae «nombre (categoría)» y el sid yc:nombre:idioma). */
function nombreIdioma(t: ContentTemplate): { name: string; language: string } {
  const p = parseYcSid(t.sid);
  return p ? { name: p.name, language: p.language } : { name: t.sid, language: "" };
}

export async function renderPlantillas(env: Env, q: Record<string, string | undefined> = {}): Promise<string> {
  const prov = proveedor(env);
  const [plantillas, asignadas] = await Promise.all([
    prov ? listContentTemplates(env).catch(() => [] as ContentTemplate[]) : Promise.resolve([] as ContentTemplate[]),
    Promise.all((Object.keys(ROLES) as RolPlantilla[]).map(async (r) => [r, await plantillaDe(env, r)] as const)),
  ]);
  const asig = new Map(asignadas);
  const conCrm = campanasPorPlantillaBloqueadas(env);

  const aviso = q.ok
    ? `<div style="border:1px solid var(--ok);padding:10px 14px;margin-bottom:16px;font-size:12.5px">Guardado. La función usará esa plantilla desde su siguiente corrida.</div>`
    : q.err
      ? `<div style="border:1px solid var(--bad);color:var(--bad);padding:10px 14px;margin-bottom:16px;font-size:12.5px">${esc(q.err)}</div>`
      : "";

  const tarjetas = (Object.keys(ROLES) as RolPlantilla[]).map((rol) => {
    const def = ROLES[rol];
    const a = asig.get(rol);
    const estado = a
      ? `<span style="color:var(--ok);font-size:11px">✓ ${esc(a.name)} · ${esc(a.language)} <span class="text-dim">(${a.origen === "panel" ? "elegida aquí" : "de variable de entorno"})</span></span>`
      : `<span class="text-dim" style="font-size:11px">Sin plantilla: la función no escribe fuera de la ventana de 24 h.</span>`;
    const quitar = a
      ? `<form method="post" action="/admin/plantillas/asignar" style="display:inline;margin:0"><input type="hidden" name="rol" value="${rol}"><input type="hidden" name="nombre" value="-"><button type="submit" style="font-size:11px;padding:3px 8px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer">Quitar</button></form>`
      : "";
    return `<div class="border border-line bg-panel" style="padding:14px 16px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline">
        <div class="text-cream text-[13.5px] font-semibold">${esc(def.titulo)}</div>${quitar}</div>
      <div class="text-dim text-[11.5px]" style="margin-top:3px">${esc(def.uso)} Necesita ${def.variables} variables: ${esc(def.ejemplo)}.</div>
      <div style="margin-top:8px">${estado}</div>
    </div>`;
  });

  const filas = plantillas.length
    ? plantillas.map((t) => {
        const ni = nombreIdioma(t);
        const interna = esAvisoInterno(ni.name, t.body, env.DUENO_NOMBRE);
        const botones = (Object.keys(ROLES) as RolPlantilla[])
          .filter((rol) => !interna && t.variables.length === ROLES[rol].variables && PISTA[rol].test(ni.name))
          .map((rol) => {
            const enUso = asig.get(rol)?.name === ni.name && asig.get(rol)?.language === ni.language;
            return enUso
              ? `<span style="font-size:11px;color:var(--ok)">✓ ${esc(ROLES[rol].titulo)}</span>`
              : `<form method="post" action="/admin/plantillas/asignar" style="display:inline;margin:0"><input type="hidden" name="rol" value="${rol}"><input type="hidden" name="nombre" value="${esc(ni.name)}"><input type="hidden" name="idioma" value="${esc(ni.language)}">
                  <button type="submit" style="font-size:11px;padding:5px 9px;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;white-space:nowrap">Usar para ${esc(ROLES[rol].titulo.toLowerCase())}</button></form>`;
          })
          .join(" ");
        return `<div style="border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:14px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap">
          <div style="min-width:0;flex:1">
            <div class="text-cream text-[12.5px]"><span class="font-mono">${esc(t.name)}</span> <span class="text-dim">· ${esc(ni.language)} · ${t.variables.length} variable(s)</span></div>
            <div class="text-muted text-[12px]" style="margin-top:4px;line-height:1.5;white-space:pre-wrap">${esc(t.body.slice(0, 280))}${t.body.length > 280 ? "…" : ""}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${botones || `<span class="text-dim" style="font-size:11px">${interna ? "Aviso interno para ti" : "Para campañas"}</span>`}</div>
        </div>`;
      }).join("")
    : `<div class="text-dim text-[12px]" style="padding:16px">${prov ? "No hay plantillas aprobadas en la cuenta, o no se pudieron leer." : "WhatsApp no está conectado."}</div>`;

  const body = `<div style="max-width:900px;display:flex;flex-direction:column;gap:18px">
    ${aviso}
    <p class="text-muted text-[12.5px]" style="line-height:1.6;margin:0">Las plantillas son los únicos mensajes que WhatsApp deja mandar <b>fuera de la ventana de 24 h</b>. Se crean y se aprueban en ${prov === "YCloud" ? "YCloud (o WhatsApp Manager)" : "WhatsApp Manager"}; aquí eliges cuál usa cada función.${prov ? ` Conectado por <b>${esc(prov)}</b>.` : ""}</p>
    ${conCrm ? `<p class="text-[12px]" style="margin:0;padding:10px 12px;border:1px solid var(--line);color:var(--muted)">Este bot está conectado al CRM: las campañas y la reactivación por plantilla las manda el Copiloto con su permiso de contacto. Lo que asignes aquí se usa solo si esas funciones se encienden en el bot.</p>` : ""}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">${tarjetas.join("")}</div>
    <div>
      <div class="text-dim" style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:8px">Plantillas aprobadas en tu cuenta (${plantillas.length})</div>
      <div class="border border-line bg-panel">${filas}</div>
    </div>
  </div>`;
  return layout({ title: "Plantillas", activeTab: "plantillas", body, env });
}
