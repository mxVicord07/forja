import type { Env } from "../env";
import type { NichePack } from "./types";
import { generico } from "./generico";
import { barberia } from "./barberia";
import { salon } from "./salon";
import { spa } from "./spa";
import { clinica } from "./clinica";
import { dentista } from "./dentista";
import { gimnasio } from "./gimnasio";
import { coach } from "./coach";
import { restaurante } from "./restaurante";
import { cafeteria } from "./cafeteria";
import { panaderia } from "./panaderia";
import { tienda } from "./tienda";

export type { NichePack, NicheColumn } from "./types";

// Registro de packs. Agregar un nicho = importar su archivo y sumarlo aquí.
// Los giros viven «en reserva»: solo se activan si BOT_NICHE trae su id al
// instalar para un cliente. Sin BOT_NICHE (el bot de BIRevX) todo es genérico.
// Portados de Forja+ v1.0.51 el 13-nov-2026: 7 de citas y 4 de pedidos y
// reservas. Pendientes: inmobiliaria, hotelería y crm.
// OJO licencia: instalar estos giros en clientes está pendiente de confirmar
// con Horizontes IA (punto F4 del playbook de Forja).
const PACKS: Record<string, NichePack> = {
  generico,
  barberia,
  salon,
  spa,
  clinica,
  dentista,
  gimnasio,
  coach,
  restaurante,
  cafeteria,
  panaderia,
  tienda,
};

/** Todos los packs registrados (para pruebas y para listar giros disponibles). */
export const ALL_NICHES: readonly NichePack[] = Object.values(PACKS);

/** Ids de giro válidos para BOT_NICHE. */
export const NICHE_IDS: readonly string[] = Object.keys(PACKS);

/** Resuelve el pack activo desde BOT_NICHE. Nicho ausente/desconocido → genérico. */
export function getNiche(env: Env): NichePack {
  const id = (env.BOT_NICHE ?? "").trim().toLowerCase();
  return PACKS[id] ?? generico;
}

// Giros que agendan citas por naturaleza. Forja Inbox (Centro de
// Mantenimiento) lo usa para el bloque `appointments`; tools/index.ts, para
// decidir si el giro lleva registrarCita cuando no hay agenda conectada.
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
