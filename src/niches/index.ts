import type { Env } from "../env";
import type { NichePack } from "./types";
import { generico } from "./generico";

export type { NichePack, NicheColumn } from "./types";

// Registro de packs. Agregar un nicho = importar su archivo y sumarlo aquí.
const PACKS: Record<string, NichePack> = {
  generico,
};

/** Resuelve el pack activo desde BOT_NICHE. Nicho ausente/desconocido → genérico. */
export function getNiche(env: Env): NichePack {
  const id = (env.BOT_NICHE ?? "").trim().toLowerCase();
  return PACKS[id] ?? generico;
}

// Ids de los 7 giros de Forja+ que agendan citas por naturaleza (barbería,
// salón, clínica, coach…) — NINGUNO tiene pack propio en este fork (los 14
// giros verticales viven en Forja+, no en el repo público; ver CLAUDE.md).
// `nicheSchedulesAppointments` siempre resuelve `false` acá porque `getNiche`
// solo conoce "generico" — correcto: la agenda de ESTE bot (Cal.com, ver
// tools/scheduleAppointment.ts) es independiente del nicho, gateada por
// BOT_TIER, no por giro. Se porta igual para que Forja Inbox (Centro de
// Mantenimiento) compile y muestre el bloque `appointments` en `false` en vez
// de tronar por el import faltante.
const APPOINTMENT_NICHE_IDS: ReadonlySet<string> = new Set([
  "barberia",
  "salon",
  "dentista",
  "clinica",
  "spa",
  "gimnasio",
  "coach",
]);

/** ¿El nicho de este bot agenda citas por diseño del giro (no por Cal.com)? */
export function nicheSchedulesAppointments(env: Env): boolean {
  return APPOINTMENT_NICHE_IDS.has(getNiche(env).id);
}
