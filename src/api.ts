// Control-plane API — glue so Forja Inbox (la app de iPhone) y un futuro panel
// hospedado puedan leer y operar este bot self-hosted. Montado en /api desde
// index.ts. Toda ruta va detrás de requireControlPlane (Bearer fail-closed).
import { Hono } from "hono";
import type { Env } from "./env";
import { channelStatuses } from "./admin/views/conexiones";
import { businessLocation } from "./businessContext";
import { Db } from "./db/client";
import { SettingsRepo, SETTING_KEYS } from "./db/settings";
import { requireControlPlane } from "./http-auth";
import { readSuperpowers } from "./settings-mutations";
import { effectiveTier } from "./tier";
import { BOT_VERSION } from "./version";
import { composioEnabled, listConnectedTools, getComposioContext } from "./integrations/composio";
import { inboxApi } from "./api-inbox";
import { maintenanceApi } from "./api-maintenance";
import { pauseState, type PausedMode } from "./lib/pause-state";
import { NOT_TEST_CONV, NOT_TEST_REF, NOT_TEST_REF_NULLABLE } from "./db/testFilter";
import { maskContact } from "./lib/mask";
import { applyBudgetGuard, monthIaCostUsd, monthStartMs } from "./budget";
import { monthIaBreakdown } from "./db/ia-usage";
import { DEFAULT_MONTHLY_BUDGET_USD } from "./settings-loader";
import { LEAD_STATUSES, leadMetadata } from "./db/leads";
import { decodeCursor, encodeCursor } from "./lib/cursor";
import { isPro } from "./config";

/** Centavos: el dinero viaja redondeado, no con la cola binaria del float. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const apiApp = new Hono<{ Bindings: Env }>();

// Pausa global del bot. La implementación vive en lib/pause-state.ts; se
// re-exporta aquí porque este ES el módulo público de la API del control plane.
export { pauseState, type PausedMode };

// Fail-closed Bearer guard on the whole sub-app (same pattern as /admin, /funnels).
apiApp.use("*", async (c, next) => {
  if (!requireControlPlane(c.req.raw, c.env)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

// Inbox móvil (Forja Inbox): /api/conversations*, /api/admin-link. Montado
// DESPUÉS del guard, así hereda el mismo Bearer fail-closed.
apiApp.route("/", inboxApi);

// Centro de Mantenimiento: /api/maintenance, /api/tickets*. Mismo montaje,
// mismo guard.
apiApp.route("/", maintenanceApi);

// GET /api/health → liveness + identity. Reporta el tier EFECTIVO (override
// del control plane incluido), no el var estático — es la verdad del bot.
apiApp.get("/health", async (c) =>
  c.json({ ok: true, version: BOT_VERSION, tier: await effectiveTier(c.env) }, 200),
);

// GET /api/config → resumen de configuración para Forja Inbox: negocio,
// nicho, idioma, canales conectados (estado, JAMÁS secrets), superpoderes y
// pausa. Con esto la app pinta la pantalla de estado del bot completa.
apiApp.get("/config", async (c) => {
  const db = new Db(c.env.DB);
  const settings = new SettingsRepo(db);
  const [botNameOverride, paused, allS, openTickets] = await Promise.all([
    settings.get(SETTING_KEYS.botName),
    settings.get(SETTING_KEYS.botPaused),
    settings.all(),
    // Pendientes abiertos: un COUNT sobre el índice de status, para que la
    // app pinte el badge sin pedir el mantenimiento completo.
    db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tickets WHERE status != 'resolved' AND ${NOT_TEST_REF_NULLABLE}`,
    ),
  ]);
  // Pausa efectiva = switch manual O pausa temporal vigente (mismo OR que
  // settings-loader). paused_until viaja para que la app muestre "hasta cuándo".
  const pausa = pauseState(paused, allS[SETTING_KEYS.botPausedUntil]);

  // Estado EFECTIVO de cada superpoder — misma tabla que usa el Centro de
  // Mantenimiento (settings-mutations.ts).
  const superpowers = readSuperpowers(allS);
  const channels = channelStatuses(c.env).map((ch) => ({
    id: ch.id,
    name: ch.name,
    connected: ch.ok,
  }));

  // Composio: solo estado/config para la app — NUNCA la API key del miembro
  // ni ningún otro secret (ver src/integrations/composio.ts).
  const composioIsEnabled = composioEnabled(c.env);
  const [composioTools, composioContext] = composioIsEnabled
    ? await Promise.all([listConnectedTools(c.env), getComposioContext(c.env)])
    : [[], {}];
  const composio = {
    enabled: composioIsEnabled,
    toolkits: [...new Set(composioTools.map((t) => t.toolkitSlug))],
    context: composioContext,
  };

  return c.json(
    {
      ok: true,
      business: c.env.BUSINESS_NAME ?? "",
      // Ubicación del negocio (member/config.local, la MISMA que ve el bot en
      // su business context). null si el onboarding no la capturó.
      address: businessLocation(),
      bot_name: botNameOverride || c.env.BOT_NAME || "",
      niche: c.env.BOT_NICHE || "generico",
      language: c.env.BOT_LANGUAGE || "es",
      channels,
      channels_connected: channels.filter((ch) => ch.connected).length,
      channels_total: channels.length,
      paused: pausa.paused,
      paused_until: pausa.paused_until,
      // Con qué modo está apagado — la app distingue "hasta que lo prenda" de
      // "hasta las 18:00" sin adivinar por el timestamp.
      paused_mode: pausa.paused_mode,
      tone: allS[SETTING_KEYS.tone] ?? "",
      bot_language: allS[SETTING_KEYS.botLanguage] ?? "",
      bot_currency: allS[SETTING_KEYS.botCurrency] ?? "",
      superpowers, // estado on/off de los superpoderes (Centro de Mantenimiento)
      // Cuántos pendientes tiene el dueño esperándolo: el badge de la app.
      open_tickets: openTickets?.n ?? 0,
      // Dominio canónico del panel: "" si el miembro no fijó DASHBOARD_BASE_URL.
      panel_url: (c.env.DASHBOARD_BASE_URL ?? "").trim().replace(/\/+$/, ""),
      version: BOT_VERSION,
      tier: await effectiveTier(c.env),
      composio,
    },
    200,
  );
});

// GET /api/leads?limit=20 → leads recientes para la Bandeja de clientes de
// Forja Inbox. PRINCIPIO DE PRIVACIDAD: la app LEE en vivo, no almacena.
// Devolvemos lo justo para la bandeja (nombre, canal, intención, estado,
// cuándo, nota corta) — el contenido completo de la conversación NUNCA sale
// del bot; para eso está el panel /admin del propio bot.
const LEADS_LIMIT_MAX = 100;

apiApp.get("/leads", async (c) => {
  const raw = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), LEADS_LIMIT_MAX) : 20;

  // Dominio REAL del status (db/leads.ts, el mismo del panel): un slug
  // inventado devolvería lista vacía y parecería "no hay interesados".
  const status = (c.req.query("status") ?? "").trim();
  if (status && !(LEAD_STATUSES as readonly string[]).includes(status)) {
    return c.json({ ok: false, error: "invalid_status" }, 400);
  }

  // OJO con el filtro del chat de prueba: conversation_id es NULLABLE en
  // leads (ON DELETE SET NULL), así que va la variante nullable-safe o se
  // pierden los leads sin conversación — ver db/testFilter.ts.
  const conds: string[] = [NOT_TEST_REF_NULLABLE];
  const params: (string | number)[] = [];
  if (status) {
    conds.push("status = ?");
    params.push(status);
  }
  const cursor = decodeCursor(c.req.query("cursor"));
  if (cursor) {
    conds.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(cursor[0], cursor[0], cursor[1]);
  }

  const rows = await new Db(c.env.DB).all<{
    id: string; conversation_id: string | null; name: string | null; contact: string | null;
    channel_user_id: string | null; intent: string; notes: string | null; status: string | null;
    metadata: string | null; created_at: number; updated_at: number;
  }>(
    `SELECT id, conversation_id, name, contact, channel_user_id, intent, notes, status,
            metadata, created_at, updated_at
       FROM leads
      WHERE ${conds.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [...params, limit + 1],
  );

  const page = rows.slice(0, limit);
  const leads = page.map((r) => {
    const campos = leadMetadata(r);
    return {
      id: r.id,
      name: r.name || "Cliente",
      // contacto enmascarado: suficiente para reconocerlo, sin volcar el dato entero.
      contact_hint: maskContact(r.contact),
      intent: r.intent,
      status: r.status || "new",
      notes: (r.notes || "").slice(0, 140),
      created_at: r.created_at,
      updated_at: r.updated_at,
      // Con esto la app abre el hilo desde la fila del interesado.
      conversation_id: r.conversation_id,
      // El id de conversación ES `${channel}:${channelUserId}` (makeConvId).
      channel: r.conversation_id ? r.conversation_id.split(":")[0] : null,
      // Campos propios del giro (fecha de la cita, modelo del coche…). null
      // cuando no hay ninguno: la app no pinta una sección vacía.
      metadata: Object.keys(campos).length ? campos : null,
    };
  });

  const last = page[page.length - 1];
  const next_cursor = rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null;
  return c.json({ ok: true, leads, count: leads.length, next_cursor }, 200);
});

/** Tope de la pausa temporal: 30 días. Más que eso es "apagarlo", no pausarlo. */
const MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

// POST /api/pause {until} — apagar/prender el bot desde Forja Inbox:
//   · <epochMs>  → pausa con hora de término ("1 hora", "hasta mañana 9:00")
//   · "manual"   → apagado hasta que el dueño lo prenda
//   · null       → prendido
// Escribe los MISMOS settings que ya lee settings-loader (bot_paused /
// bot_paused_until), así que no hay una segunda fuente de verdad de la pausa.
apiApp.post("/pause", async (c) => {
  let body: { until?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const repo = new SettingsRepo(new Db(c.env.DB));
  const now = Date.now();
  const until = body.until;
  let untilSetting = "";
  let pausedSetting = "0";

  if (until === "manual") {
    pausedSetting = "1";
  } else if (typeof until === "number") {
    if (!Number.isInteger(until) || until <= now || until > now + MAX_PAUSE_MS) {
      return c.json({ ok: false, error: "invalid_until" }, 400);
    }
    untilSetting = String(until);
    // El switch manual se APAGA a propósito: la pausa efectiva es un OR, así
    // que un bot_paused="1" viejo volvería eterna una pausa que sí tiene fin.
  } else if (until !== null) {
    return c.json({ ok: false, error: "invalid_until" }, 400);
  }

  await repo.set(SETTING_KEYS.botPaused, pausedSetting);
  await repo.set(SETTING_KEYS.botPausedUntil, untilSetting);
  return c.json({ ok: true, ...pauseState(pausedSetting, untilSetting, now) }, 200);
});

// GET /api/cost → gasto de IA del mes para la tab Costos de Forja Inbox: costo
// real por tokens, tope del dueño (default $25), proyección de fin de mes y
// el veredicto del guard de presupuesto.
apiApp.get("/cost", async (c) => {
  const db = new Db(c.env.DB);
  const now = Date.now();
  const monthUsd = await monthIaCostUsd(db, now);

  // Desglose por función desde la libreta (ia_usage). `ledger_usd` es el
  // total REAL — TODAS las funciones (conversación + copilot + flywheel +
  // blindaje…), con caché-creation a 1.25×. `month_usd` (arriba) sigue siendo
  // el número del guard (solo conversación, de `messages`) por compatibilidad.
  // En bots recién actualizados el desglose arranca vacío y se llena solo
  // desde su primera llamada.
  const breakdown = await monthIaBreakdown(db, now);
  const ledgerUsd = breakdown.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

  // Mismo default que settings-loader: sin setting = $25; "0" = sin tope.
  const rawBudget = ((await new SettingsRepo(db).get(SETTING_KEYS.monthlyBudget)) ?? "").trim();
  const budgetIsDefault = rawBudget === "";
  const parsed = budgetIsDefault ? DEFAULT_MONTHLY_BUDGET_USD : Number.parseFloat(rawBudget);
  const budgetUsd = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  // Proyección lineal: lo gastado por día × los días del mes. El mes se mide
  // en UTC, como monthStartMs.
  const d = new Date(now);
  const dayOfMonth = d.getUTCDate();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = dayOfMonth > 0 ? (monthUsd / dayOfMonth) * daysInMonth : 0;

  // Este fork NO tiene "hard stop": applyBudgetGuard solo baja a modelo
  // económico al llegar al tope (el bot sigue contestando, nunca se calla).
  const guard = applyBudgetGuard("smart", monthUsd, budgetUsd ?? undefined);
  return c.json(
    {
      ok: true,
      month_usd: round2(monthUsd),
      budget_usd: budgetUsd,
      budget_is_default: budgetIsDefault,
      // Tope al 100% porque la app lo pinta como barra; que se haya pasado ya
      // lo dice downgraded.
      pct: budgetUsd ? Math.min(100, Math.round((monthUsd / budgetUsd) * 100)) : null,
      projected_usd: round2(projected),
      downgraded: guard.downgraded,
      month_start: monthStartMs(now),
      currency: "USD",
      // Total real (todas las funciones) + desglose. Aditivo: la app puede
      // mostrar el desglose sin tocar los campos de arriba.
      ledger_usd: round2(ledgerUsd),
      breakdown: breakdown.map((r) => ({
        fn: r.fn,
        cost_usd: round2(r.cost_usd ?? 0),
        calls: r.calls ?? 0,
      })),
    },
    200,
  );
});

// GET /api/report/latest → el reporte diseñado del día para Forja Inbox
// (skill /reportes, owner/report/*). Sirve el último que generó el cron
// diario (persistido como DATOS, sin HTML — la app lo pinta con sus propias
// tarjetas); con ?fresh=1 arma uno al vuelo SIN persistirlo — gasta una
// llamada de IA, igual que /admin/report. Import diferido: owner/report/build
// no lo necesita ningún otro módulo de api.ts, y así se evita acoplar el
// arranque de este archivo a workModel/llm si algún día ese import creciera.
apiApp.get("/report/latest", async (c) => {
  if (!isPro(c.env)) return c.json({ ok: false, error: "pro_required" }, 403);

  const { buildReport, reportSnapshot, reportMarkdown } = await import("./owner/report/build");

  if (c.req.query("fresh") === "1") {
    const now = Date.now();
    const snap = reportSnapshot(await buildReport(c.env, now), now);
    return c.json({ ok: true, report: snap, body_markdown: reportMarkdown(snap, c.env.BUSINESS_NAME) }, 200);
  }

  const raw = await new SettingsRepo(new Db(c.env.DB)).get(SETTING_KEYS.reportLastJson);
  if (!raw) return c.json({ ok: false, error: "no_report" }, 404);
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    // Setting corrupto: para la app es lo mismo que no tener reporte todavía.
    return c.json({ ok: false, error: "no_report" }, 404);
  }

  // El markdown NO se persiste (sería el mismo texto dos veces en D1): se
  // arma desde el snapshot, que es todo lo que el renderer necesita.
  const snap = report as import("./owner/report/build").ReportSnapshot;
  return c.json({ ok: true, report: snap, body_markdown: reportMarkdown(snap, c.env.BUSINESS_NAME) }, 200);
});

export type MetricsRange = "7d" | "30d" | "all";

/** Window start (ms epoch) for a range. "all" = 0 (no lower bound). */
export function sinceForRange(range: MetricsRange, now: number): number {
  if (range === "all") return 0;
  const days = range === "30d" ? 30 : 7; // default / fallback = 7d
  return now - days * 24 * 60 * 60 * 1000;
}

/** Normalize the ?range query param to a supported value (default 7d). */
export function parseRange(raw: string | undefined): MetricsRange {
  return raw === "30d" || raw === "all" ? raw : "7d";
}

export interface MetricsResponse {
  range: MetricsRange;
  leads: number;
  messages: number;
  conversations: number;
  health_score: number;
}

/**
 * Aggregate the bot's activity over the requested window from the real D1
 * tables (schema.sql):
 *   leads          = COUNT(leads)          created_at >= since
 *   messages       = COUNT(messages)       created_at >= since
 *   conversations  = COUNT(conversations)  last_message_at >= since (active in window)
 *
 * health_score (0–100): the share of in-window conversations that did NOT get
 * escalated to a human — i.e. never opened a handoff ticket (the tickets table
 * is written only on handoffHuman). 100 = nobody had to be escalated; lower =
 * more conversations needed a human. escalated is clamped to [0, conversations]
 * so the ratio stays in range, and with zero conversations we report 100
 * (no traffic ≠ unhealthy).
 */
export async function computeMetrics(
  db: Db,
  range: MetricsRange,
  now = Date.now(),
): Promise<MetricsResponse> {
  const since = sinceForRange(range, now);

  // El chat de prueba de la app (canal `test`) no es tráfico del negocio y no
  // cuenta en ninguna métrica — ver src/db/testFilter.ts.
  const leads =
    (await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND ${NOT_TEST_REF_NULLABLE}`,
      [since],
    ))?.n ?? 0;
  const messages =
    (await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND ${NOT_TEST_REF}`,
      [since],
    ))?.n ?? 0;
  const conversations =
    (await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM conversations WHERE last_message_at >= ? AND ${NOT_TEST_CONV}`,
      [since],
    ))?.n ?? 0;

  // Distinct conversations that opened a handoff ticket in the window.
  const escalatedRaw =
    (await db.first<{ n: number }>(
      `SELECT COUNT(DISTINCT conversation_id) AS n FROM tickets
        WHERE conversation_id IS NOT NULL AND created_at >= ? AND ${NOT_TEST_REF}`,
      [since],
    ))?.n ?? 0;

  const escalated = Math.min(escalatedRaw, conversations);
  const healthScore =
    conversations === 0
      ? 100
      : Math.max(0, Math.min(100, Math.round(((conversations - escalated) / conversations) * 100)));

  return { range, leads, messages, conversations, health_score: healthScore };
}

// GET /api/metrics?range=7d|30d|all → aggregates for the control-plane dashboard.
apiApp.get("/metrics", async (c) => {
  const range = parseRange(c.req.query("range"));
  const metrics = await computeMetrics(new Db(c.env.DB), range);
  return c.json(metrics, 200);
});
