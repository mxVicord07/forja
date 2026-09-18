/**
 * Estado de CONFIGURACIÓN de cada superpoder, en vivo (env + settings). Fuente
 * ÚNICA para el `superpowers_meta` del GET /api/maintenance (Forja Inbox).
 *
 * Porteo RECORTADO del paquete Forja+ v1.0.76 — solo los superpoderes que este
 * fork tiene (ver settings-mutations.ts): se excluyen `payments` (Stripe,
 * `integrations/stripe.ts` no existe acá) y `boveda` (R2 de Bóveda, no
 * portado). `reengage` se adapta a la única vía que este fork soporta
 * (plantilla de Meta Cloud API por nombre — `reengageTemplateName`), no el SID
 * de Twilio que el paquete original también reconocía.
 *
 * Fail-open en lectura: si un check no puede determinarse, `configured:true`
 * para no bloquear de más — el runtime del superpoder igual valida su propio
 * prerequisito antes de actuar.
 */
import type { Env } from "../env";
import { SETTING_KEYS } from "../db/settings";
import { SUPERPOWERS, type SuperpowerId } from "../settings-mutations";

/**
 * Entrada de `superpowers_meta`. Para los toggles limpios solo viaja
 * `configurable:false`; para los que piden setup, el estado en vivo + los
 * datos para guiar al dueño al panel (`hint`/`panel`), presentes SOLO cuando
 * de verdad falta algo.
 */
export interface SuperpowerMetaEntry {
  configurable: boolean;
  configured?: boolean;
  needs?: string[];
  hint?: string;
  panel?: string;
}

/** Descriptor estático + check en vivo de un superpoder que REQUIERE setup. */
interface ConfigurableDescriptor {
  needs: string[];
  hint?: string;
  panel?: string;
  isConfigured: (env: Env, settings: Record<string, string>) => boolean;
}

/**
 * Los superpoderes con prerequisito. Los otros tres (salesHunter, blindaje,
 * dailyReport) son toggle limpio → NO aparecen aquí y salen como
 * `{ configurable:false }`.
 */
const CONFIGURABLE: Partial<Record<SuperpowerId, ConfigurableDescriptor>> = {
  // Tiene default válido ("numerico") → siempre cuenta como configurado.
  // `configurable:true` porque el modo SE puede cambiar, pero nunca bloquea.
  satisfactionSurvey: {
    needs: [],
    isConfigured: () => true,
  },
  // El link de reseña de Google, no vacío.
  reviews: {
    needs: ["review_url"],
    hint: "Falta el link de reseña",
    panel: "reviews",
    isConfigured: (_env, s) => (s[SETTING_KEYS.reviewUrl] ?? "").trim() !== "",
  },
  // Nombre de la plantilla aprobada de WhatsApp Cloud API (Meta) para
  // reenganchar fuera de la ventana de 24h. Este fork no soporta la vía de
  // Twilio Content SID que el paquete original también checaba.
  reengage: {
    needs: ["reengage_template"],
    hint: "Falta una plantilla aprobada de WhatsApp (Meta Cloud API)",
    panel: "reengage",
    isConfigured: (_env, s) => (s[SETTING_KEYS.reengageTemplateName] ?? "").trim() !== "",
  },
};

/**
 * Estado de configuración de UN superpoder. Lo usan tanto el
 * `superpowers_meta` como (a futuro, si se porta) la reja de un PATCH, para
 * que "lo que la app ve" y "lo que el backend dejaría prender" no se
 * desincronicen.
 */
export function superpowerConfig(
  id: SuperpowerId,
  env: Env,
  settings: Record<string, string>,
): SuperpowerMetaEntry {
  const desc = CONFIGURABLE[id];
  if (!desc) return { configurable: false };

  const configured = desc.isConfigured(env, settings);
  const entry: SuperpowerMetaEntry = { configurable: true, configured, needs: desc.needs };
  if (!configured) {
    if (desc.hint) entry.hint = desc.hint;
    if (desc.panel) entry.panel = desc.panel;
  }
  return entry;
}

/** `superpowers_meta` completo: una entrada por cada superpoder. */
export function superpowersMeta(
  env: Env,
  settings: Record<string, string>,
): Record<SuperpowerId, SuperpowerMetaEntry> {
  const out = {} as Record<SuperpowerId, SuperpowerMetaEntry>;
  for (const def of SUPERPOWERS) out[def.id] = superpowerConfig(def.id, env, settings);
  return out;
}
