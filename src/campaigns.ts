/**
 * Campañas de WhatsApp: envío por segmento con respeto a la ventana de 24h y
 * al límite diario de plantillas del número.
 *
 * - Dentro de ventana (últ. msg <23h): mensaje FREE-FORM (gratis, sin plantilla).
 * - Fuera de ventana: plantilla HSM aprobada (Twilio Content API), que cuenta
 *   contra el tope diario de conversaciones iniciadas por el negocio
 *   (WA_DAILY_TEMPLATE_CAP, default 250 — el tier 1 de Meta).
 *
 * Anti-doble-envío: claim-before-send en template_sends con UNIQUE
 * (campaign_key, conversation_id) — reintentar una campaña NUNCA duplica.
 */
import type { Env } from "./env";
import { Db } from "./db/client";
import { MessagesRepo } from "./db/messages";
import { segmentMembers } from "./segments";
import { pickAdapter } from "./replies/sender";
import type { ChannelId } from "./channels/shared";
import { resolveWaProvider } from "./replies/sender";
import { sendYCloudTemplate } from "./channels/ycloud";

// ── Plantillas por YCloud (I-034) ─────────────────────────────────────────
// Forma verificada contra la API real de YCloud el 12-nov-2026:
//   GET https://api.ycloud.com/v2/whatsapp/templates → { offset, limit, length, items: [{ name, language, status, category, components: [{ type, text }] }] }
// El «sid» de una plantilla de YCloud es `yc:<nombre>:<idioma>`; así el resto de Forja (Campañas) la trata igual que una de Twilio.
const YCLOUD_TEMPLATES_URL = "https://api.ycloud.com/v2/whatsapp/templates?page=1&limit=100";
export const YC_PREFIX = "yc:";

export function parseYcSid(sid: string): { name: string; language: string } | null {
  const m = /^yc:([a-z0-9_]{1,512}):([A-Za-z_]{2,10})$/.exec(sid);
  return m ? { name: m[1], language: m[2] } : null;
}

/** Variables {{1}}, {{2}}… del cuerpo, en orden numérico y sin repetir. */
export function templateVariables(body: string): string[] {
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b).map(String);
}

/** Plantillas APROBADAS de la cuenta de YCloud. Nunca lanza: sin llave o con error devuelve []. */
export async function listYCloudTemplates(env: Env): Promise<ContentTemplate[]> {
  if (!env.YCLOUD_API_KEY) return [];
  try {
    const res = await fetch(YCLOUD_TEMPLATES_URL, { headers: { "X-API-Key": env.YCLOUD_API_KEY } });
    if (!res.ok) {
      console.error("[campaigns] YCloud templates error:", res.status);
      return [];
    }
    const data = (await res.json()) as { items?: any[] };
    return (data.items ?? [])
      .filter((t) => t && t.status === "APPROVED" && typeof t.name === "string" && typeof t.language === "string")
      .map((t) => {
        const body: string = (Array.isArray(t.components) ? t.components : []).find((c: any) => c?.type === "BODY")?.text ?? "";
        return { sid: `${YC_PREFIX}${t.name}:${t.language}`, name: `${t.name} (${String(t.category ?? "").toLowerCase() || "sin categoría"})`, body, variables: templateVariables(body), variableExamples: {} };
      })
      .filter((t) => parseYcSid(t.sid) !== null);
  } catch (e) {
    console.error("[campaigns] YCloud templates falló:", e);
    return [];
  }
}

/**
 * ¿El bot está conectado a un CRM que lleva el consentimiento de WhatsApp? Ahí las plantillas masivas salen por el
 * CRM, con su guarda de consentimiento; una campaña desde Forja se la saltaría, así que se bloquea.
 */
export function campanasPorPlantillaBloqueadas(env: Env): boolean {
  return Boolean(env.CRM_FICHA_URL || env.CRM_AGENDA_URL || env.CRM_SEGUIMIENTO_URL);
}

export interface ContentTemplate {
  sid: string;
  name: string;
  body: string;
  variables: string[]; // nombres de variables {{1}}, {{2}}…
  /** Valor de ejemplo que la cuenta registró para cada variable en Twilio —
   *  Forja Inbox lo usa como placeholder editable en el sheet de plantillas.
   *  Twilio ya lo devuelve en `c.variables`; antes lo descartábamos. */
  variableExamples: Record<string, string>;
}

/** Plantillas HSM de la cuenta (Twilio Content API). */
export async function listContentTemplates(env: Env): Promise<ContentTemplate[]> {
  // Con YCloud como proveedor de WhatsApp, las plantillas son las de la cuenta de YCloud.
  if (resolveWaProvider(env) === "ycloud") return listYCloudTemplates(env);
  const sid = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return [];
  const res = await fetch("https://content.twilio.com/v1/Content?PageSize=50", {
    headers: { Authorization: `Basic ${btoa(`${sid}:${tok}`)}` },
  });
  if (!res.ok) {
    console.error("[campaigns] Content API error:", res.status);
    return [];
  }
  const data = (await res.json()) as { contents?: any[] };
  return (data.contents ?? []).map((c) => {
    const types = c.types ?? {};
    const body: string =
      types["twilio/text"]?.body ?? types["twilio/quick-reply"]?.body ?? types["twilio/call-to-action"]?.body ?? "";
    return {
      sid: c.sid as string,
      name: (c.friendly_name as string) ?? c.sid,
      body,
      variables: Object.keys(c.variables ?? {}),
      variableExamples: Object.fromEntries(
        Object.entries(c.variables ?? {}).map(([k, v]) => [k, String(v ?? "")]),
      ),
    };
  });
}

export function dailyTemplateCap(env: Env): number {
  const n = Number.parseInt(env.WA_DAILY_TEMPLATE_CAP ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 250;
}

/** Plantillas mandadas en las últimas 24h (rolling) — el gasto del tope diario. */
export async function templatesSentLast24h(db: Db, now = Date.now()): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM template_sends WHERE kind = 'template' AND sent_at > ?",
    [now - 24 * 3600_000],
  );
  return row?.n ?? 0;
}

export interface CampaignResult {
  segment: string;
  audience: number;
  sentFreeform: number;
  sentTemplate: number;
  skippedDuplicate: number;
  skippedQuota: number;
  failed: number;
}

/**
 * Manda una campaña a un segmento.
 * - freeformText: se manda a los que están DENTRO de ventana (si se da).
 * - template: se manda a los que están FUERA (si se da), hasta agotar cuota.
 * Se puede dar solo uno de los dos (p.ej. solo free-form a los de ventana).
 */
export async function sendCampaign(
  env: Env,
  opts: {
    segmentId: string;
    campaignKey: string; // identificador humano — el candado anti-duplicados
    freeformText?: string;
    /** body = texto de la plantilla — se persiste en el historial para que el
     *  agente tenga contexto cuando el cliente responda ("SÍ", "REPLAY"…). */
    template?: { sid: string; variables?: Record<string, string>; body?: string };
    now?: number;
  },
): Promise<CampaignResult> {
  const now = opts.now ?? Date.now();
  const db = new Db(env.DB);
  const msgs = new MessagesRepo(db);
  // Un bot conectado al CRM no manda plantillas masivas desde aquí: se saltaría la guarda de consentimiento del CRM.
  if (opts.template && campanasPorPlantillaBloqueadas(env)) {
    throw new Error("En este bot las plantillas salen por el CRM, que revisa el consentimiento de cada contacto. Manda la campaña solo con texto libre (a quienes escribieron en las últimas 24 h) o usa el seguimiento del CRM.");
  }
  const members = await segmentMembers(db, opts.segmentId, now);

  const cap = dailyTemplateCap(env);
  let spent = await templatesSentLast24h(db, now);

  const result: CampaignResult = {
    segment: opts.segmentId,
    audience: members.length,
    sentFreeform: 0,
    sentTemplate: 0,
    skippedDuplicate: 0,
    skippedQuota: 0,
    failed: 0,
  };

  for (const m of members) {
    const useFreeform = m.inWindow && opts.freeformText;
    const useTemplate = !m.inWindow && opts.template;
    if (!useFreeform && !useTemplate) continue;

    if (useTemplate && spent >= cap) {
      result.skippedQuota++;
      continue;
    }

    // Claim ANTES de mandar — si ya existe (campaña reintentada), saltar.
    try {
      await db.run(
        `INSERT INTO template_sends (campaign_key, conversation_id, kind, template_sid, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          opts.campaignKey,
          m.conversationId,
          useFreeform ? "freeform" : "template",
          useTemplate ? opts.template!.sid : null,
          now,
        ],
      );
    } catch {
      result.skippedDuplicate++;
      continue;
    }

    try {
      if (useFreeform) {
        const channel = m.channel as ChannelId;
        await pickAdapter(channel, env).sendReply(
          { channel, channelUserId: m.channelUserId, chunks: [opts.freeformText!] },
          env,
        );
        await msgs.append(m.conversationId, "assistant", opts.freeformText!);
        result.sentFreeform++;
      } else {
        await sendTwilioTemplate(env, m.channelUserId, opts.template!.sid, opts.template!.variables);
        // Persistimos el TEXTO real (variables sustituidas), no el SID: cuando
        // el cliente conteste "SÍ", el agente debe ver qué se le preguntó.
        const rendered = renderTemplateBody(opts.template!.body, opts.template!.variables);
        await msgs.append(
          m.conversationId,
          "assistant",
          rendered ?? `[plantilla ${opts.template!.sid} enviada]`,
        );
        result.sentTemplate++;
        spent++;
      }
    } catch (e) {
      result.failed++;
      // El claim queda — mejor no reintentar solo que arriesgar doble mensaje.
      console.error(`[campaigns] send failed conv=${m.conversationId}:`, e);
    }
  }

  console.log(
    `[campaigns] ${opts.campaignKey} seg=${opts.segmentId} audiencia=${result.audience} ` +
      `freeform=${result.sentFreeform} plantilla=${result.sentTemplate} ` +
      `dup=${result.skippedDuplicate} cuota=${result.skippedQuota} fail=${result.failed}`,
  );
  return result;
}

/** "Hola {{1}}" + {"1":"Ana"} → "Hola Ana". null si no hay body. */
export function renderTemplateBody(
  body?: string,
  variables?: Record<string, string>,
): string | null {
  if (!body) return null;
  let out = body;
  for (const [k, v] of Object.entries(variables ?? {})) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

/** Envío de UNA plantilla HSM vía Messages API (ContentSid + ContentVariables). */
export async function sendTwilioTemplate(
  env: Env,
  toNumber: string,
  contentSid: string,
  variables?: Record<string, string>,
): Promise<void> {
  // Plantilla de YCloud (`yc:<nombre>:<idioma>`): mismo punto de entrada, otro proveedor. Variables en orden numérico.
  const yc = parseYcSid(contentSid);
  if (yc) {
    const params = Object.keys(variables ?? {}).sort((a, b) => Number(a) - Number(b)).map((k) => String(variables![k] ?? ""));
    const r = await sendYCloudTemplate(env, { to: toNumber, name: yc.name, language: yc.language, bodyParams: params });
    if (!r.ok) throw new Error(`YCloud rechazó la plantilla (${r.reason})`);
    return;
  }
  const sid = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_WA_FROM;
  if (!sid || !tok || !from) throw new Error("Twilio credentials missing");
  const body = new URLSearchParams({
    From: `whatsapp:${from}`,
    To: `whatsapp:${toNumber}`,
    ContentSid: contentSid,
  });
  if (variables && Object.keys(variables).length > 0) {
    body.set("ContentVariables", JSON.stringify(variables));
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${tok}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Twilio template send ${res.status}: ${err.slice(0, 200)}`);
  }
}

/** Historial de campañas (agrupado) para la página de campañas. */
export async function campaignHistory(db: Db, limit = 15) {
  return db.all<{
    campaign_key: string;
    freeform: number;
    template: number;
    last_at: number;
  }>(
    `SELECT campaign_key,
            SUM(CASE WHEN kind = 'freeform' THEN 1 ELSE 0 END) AS freeform,
            SUM(CASE WHEN kind = 'template' THEN 1 ELSE 0 END) AS template,
            MAX(sent_at) AS last_at
     FROM template_sends GROUP BY campaign_key ORDER BY last_at DESC LIMIT ?`,
    [limit],
  );
}


// ── Plantilla del handoff (aviso al dueño) ───────────────────────────────────

export const HANDOFF_TEMPLATE_NAME = "handoff_aviso_dueno_v2";

/**
 * Crea la plantilla HSM del aviso de handoff y la somete a aprobación de
 * WhatsApp (categoría UTILITY — notificación operativa, aprueba rápido).
 * Contrato de variables = notifyOwner: {{1}} motivo, {{2}} resumen, {{3}} link.
 */
export async function createHandoffTemplate(
  env: Env,
): Promise<{ sid: string; approval: string; name: string; body: string } | { error: string }> {
  const acct = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  if (!acct || !tok) return { error: "Twilio no configurado (SID/token)" };
  const auth = `Basic ${btoa(`${acct}:${tok}`)}`;

  // OJO Meta: la plantilla NO puede empezar ni terminar con una variable
  // (rechazo subCode 2388299) — por eso la línea de cierre estática.
  const body =
    "🔔 Tu bot te necesita con un cliente.\n\nMotivo: {{1}}\n\nResumen: {{2}}\n\nAtiende la conversación aquí: {{3}}\n\n— Aviso automático de tu bot.";
  const createRes = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      friendly_name: HANDOFF_TEMPLATE_NAME,
      language: "es_MX",
      variables: {
        "1": "el cliente pidió hablar con una persona",
        "2": "María pagó y no recibió su acceso",
        "3": "https://example.com/admin/conversations",
      },
      types: { "twilio/text": { body } },
    }),
  });
  const created = (await createRes.json()) as { sid?: string };
  if (!createRes.ok || !created.sid) {
    return { error: `create ${createRes.status}: ${JSON.stringify(created).slice(0, 180)}` };
  }

  const apprRes = await fetch(
    `https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: HANDOFF_TEMPLATE_NAME, category: "UTILITY" }),
    },
  );
  const appr = (await apprRes.json()) as { status?: string };
  // name+body en la respuesta = confirmación de QUÉ versión del código creó la
  // plantilla (un setup que corre antes de que propague un deploy crea la vieja).
  return { sid: created.sid, approval: appr.status ?? `error ${apprRes.status}`, name: HANDOFF_TEMPLATE_NAME, body };
}

/** Estado de aprobación de una plantilla (approved | pending | rejected…). */
export async function contentApprovalStatus(
  env: Env,
  sid: string,
): Promise<{ status: string; rejectionReason?: string } | { error: string }> {
  const acct = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  if (!acct || !tok) return { error: "Twilio no configurado (SID/token)" };
  const res = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, {
    headers: { Authorization: `Basic ${btoa(`${acct}:${tok}`)}` },
  });
  if (!res.ok) return { error: `status ${res.status}` };
  const data = (await res.json()) as {
    whatsapp?: { status?: string; rejection_reason?: string };
  };
  return {
    status: data.whatsapp?.status ?? "unknown",
    rejectionReason: data.whatsapp?.rejection_reason || undefined,
  };
}
