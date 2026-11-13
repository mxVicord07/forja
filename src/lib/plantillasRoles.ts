/**
 * Qué plantilla de WhatsApp usa cada función del bot (pestaña Plantillas, 13-nov-2026).
 *
 * Fuente: la configuración del panel (settings), y si no hay, las variables de
 * entorno de antes (REENGAGE_PLANTILLA, CITA_RECORDATORIO_PLANTILLA). Así lo que
 * ya funcionaba con variables sigue igual y el dueño puede cambiarlo sin desplegar.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";

export type RolPlantilla = "reenganche" | "recordatorio";

export const ROLES: Record<RolPlantilla, { titulo: string; uso: string; variables: number; ejemplo: string }> = {
  reenganche: {
    titulo: "Reactivar leads fríos",
    uso: "Le escribe a quien dejó de contestar hace 2 días o más (fuera de la ventana de 24 h).",
    variables: 2,
    ejemplo: "{{1}} nombre de pila · {{2}} tema de lo que platicaron",
  },
  recordatorio: {
    titulo: "Recordatorio de cita",
    uso: "Recuerda la cita del día siguiente cuando el cliente ya no está en la ventana de 24 h.",
    variables: 3,
    ejemplo: "{{1}} nombre · {{2}} día · {{3}} hora",
  },
};

const KEY = (rol: RolPlantilla) => ({ nombre: `plantilla_${rol}`, idioma: `plantilla_${rol}_idioma` });

function desdeEnv(env: Env, rol: RolPlantilla): { name: string; language: string } | null {
  const name = (rol === "reenganche" ? env.REENGAGE_PLANTILLA : env.CITA_RECORDATORIO_PLANTILLA)?.trim() ?? "";
  if (!name) return null;
  const language = ((rol === "reenganche" ? env.REENGAGE_PLANTILLA_IDIOMA : env.CITA_RECORDATORIO_IDIOMA) ?? "es_MX").trim();
  return { name, language };
}

/** Plantilla asignada a la función, o null. `origen` dice de dónde salió. */
export async function plantillaDe(
  env: Env,
  rol: RolPlantilla,
): Promise<{ name: string; language: string; origen: "panel" | "variable" } | null> {
  try {
    if (env.DB) {
      const s = new SettingsRepo(new Db(env.DB));
      const k = KEY(rol);
      const name = ((await s.get(k.nombre)) ?? "").trim();
      if (name === "-") return null; // apagada a propósito desde el panel
      if (name) return { name, language: ((await s.get(k.idioma)) ?? "es_MX").trim() || "es_MX", origen: "panel" };
    }
  } catch {
    /* settings no disponible: cae a la variable */
  }
  const e = desdeEnv(env, rol);
  return e ? { ...e, origen: "variable" } : null;
}

/** Guarda la asignación desde el panel. `name` "-" la apaga aunque haya variable. */
export async function asignarPlantilla(env: Env, rol: RolPlantilla, name: string, language: string): Promise<void> {
  const s = new SettingsRepo(new Db(env.DB));
  const k = KEY(rol);
  await s.set(k.nombre, name.trim().slice(0, 120), "owner");
  await s.set(k.idioma, (language.trim() || "es_MX").slice(0, 12), "owner");
}
