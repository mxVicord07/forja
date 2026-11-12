/**
 * Calendario del panel de citas (semana y mes): aritmética de fechas pura, sin
 * red ni base de datos. Todo se calcula con el día local de la zona del negocio;
 * los rangos que van a Cal.com salen en UTC. Semana de lunes a domingo.
 */
import type { CitaPanel } from "./source";

export interface Dia { y: number; m: number; d: number }
export type VistaCalendario = "semana" | "mes";

export interface CeldaCalendario { clave: string; dia: number; delMes: boolean }

const pad = (n: number) => String(n).padStart(2, "0");
export const claveDia = (p: Dia) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;

/** `YYYY-MM-DD` real (rechaza 2026-02-30 y cualquier texto extra) o null. */
export function parseDia(s: string | undefined | null): Dia | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const p = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return t.getUTCFullYear() === p.y && t.getUTCMonth() === p.m - 1 && t.getUTCDate() === p.d ? p : null;
}

export function sumarDias(p: Dia, n: number): Dia {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Día de la semana con lunes = 0. */
const diaSemana = (p: Dia) => (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;

function offsetMs(utcMs: number, tz: string): number {
  const x = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(x.find((v) => v.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(utcMs / 1000) * 1000;
}

/** Instante UTC (ISO) en que empieza ese día local. */
function inicioDiaUtc(p: Dia, tz: string): string {
  const guess = Date.UTC(p.y, p.m - 1, p.d);
  const o = offsetMs(guess, tz);
  return new Date(guess - offsetMs(guess - o, tz)).toISOString();
}

export function rangoCalendario(
  vista: VistaCalendario,
  ref: Dia,
  tz: string,
): { desde: string; hasta: string; celdas: CeldaCalendario[]; titulo: string } {
  let primero: Dia;
  let total: number;
  let titulo: string;
  if (vista === "semana") {
    primero = sumarDias(ref, -diaSemana(ref));
    total = 7;
    const ultimo = sumarDias(primero, 6);
    const f = (p: Dia) => new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));
    titulo = `${f(primero)} al ${f(ultimo)} de ${ultimo.y}`;
  } else {
    const uno = { y: ref.y, m: ref.m, d: 1 };
    primero = sumarDias(uno, -diaSemana(uno));
    const dias = new Date(Date.UTC(ref.y, ref.m, 0)).getUTCDate();
    total = Math.ceil((diaSemana(uno) + dias) / 7) * 7;
    titulo = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(ref.y, ref.m - 1, 1)));
  }
  const celdas: CeldaCalendario[] = [];
  for (let i = 0; i < total; i++) {
    const p = sumarDias(primero, i);
    celdas.push({ clave: claveDia(p), dia: p.d, delMes: vista === "semana" || (p.y === ref.y && p.m === ref.m) });
  }
  return { desde: inicioDiaUtc(primero, tz), hasta: inicioDiaUtc(sumarDias(primero, total), tz), celdas, titulo };
}

/** Día de la referencia anterior (-1) o siguiente (+1), como `YYYY-MM-DD`. */
export function navegarCalendario(vista: VistaCalendario, ref: Dia, dir: -1 | 1): string {
  if (vista === "semana") return claveDia(sumarDias(ref, 7 * dir));
  return claveDia({ y: ref.m + dir < 1 ? ref.y - 1 : ref.m + dir > 12 ? ref.y + 1 : ref.y, m: ((ref.m - 1 + dir + 12) % 12) + 1, d: 1 });
}

/** Agrupa por día local de la zona (no por día UTC). */
export function agruparPorDia(citas: CitaPanel[], tz: string): Map<string, CitaPanel[]> {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const out = new Map<string, CitaPanel[]>();
  for (const c of citas) {
    const k = fmt.format(new Date(c.inicio));
    out.set(k, [...(out.get(k) ?? []), c]);
  }
  return out;
}
