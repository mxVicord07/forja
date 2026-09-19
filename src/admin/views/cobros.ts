// Tab "Cobros" (Forja+ Pro, opt-in, skill /cobros): dinero cobrado por
// WhatsApp vía Stripe. La data ya vive en `payment_intents`
// (tools/cobros.ts la escribe, integrations/stripeWebhook.ts la confirma);
// esta vista la surfacea. Empty state: si Stripe no está conectado, guía a
// conectarlo en vez de mostrar una tabla vacía sin contexto.
import type { Env } from "../../env";
import { Db } from "../../db/client";
import { SettingsRepo, SETTING_KEYS } from "../../db/settings";
import { stripeConfigured } from "../../integrations/stripe";
import { layout, renderConfigPrompt } from "./layout";

const CONFIG_PROMPT = `Actívame el superpoder Cobros (pagos por WhatsApp vía Stripe). Sigue el skill /cobros: pídeme mi llave secreta de Stripe (sk_live_... o sk_test_...) y guárdala como secret de Cloudflare, ayúdame a configurar el webhook de Stripe apuntando a este bot, y préndeme el toggle payments_enabled cuando confirme que quiero cobrar de verdad.`;

type PayRow = {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  status: string;
  url: string | null;
  created_at: number;
  paid_at: number | null;
  conversation_id: string | null;
  channel: string | null;
  channel_user_id: string | null;
};

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  paid: { label: "Pagado", color: "var(--ok)" },
  pending: { label: "Pendiente", color: "var(--accent-2)" },
  canceled: { label: "Cancelado", color: "var(--dim)" },
};

function money(cents: number, currency: string): string {
  const cur = (currency || "mxn").toUpperCase();
  try {
    return (cents / 100).toLocaleString("es-MX", { style: "currency", currency: cur });
  } catch {
    return `$${(cents / 100).toFixed(2)} ${cur}`;
  }
}

function statCard(label: string, value: string, sub?: string): string {
  return `<div class="bg-panel border border-line" style="padding:16px 18px">
    <div class="text-dim" style="font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:6px">${label}</div>
    <div class="font-display font-bold text-cream" style="font-size:24px;letter-spacing:-.02em">${value}</div>
    ${sub ? `<div class="text-dim" style="font-size:11px;margin-top:2px">${sub}</div>` : ""}
  </div>`;
}

function connectCard(icon: string, title: string, stepsHtml: string): string {
  return `<div class="bg-panel border" style="border-color:var(--accent);border-left-width:3px;padding:18px 20px;margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px">
      <i data-lucide="${icon}" width="18" height="18" style="color:var(--accent)"></i>
      <span class="font-display font-semibold text-cream" style="font-size:14px">${title}</span>
    </div>
    <div class="text-muted" style="font-size:12.5px;line-height:1.7">${stepsHtml}</div>
  </div>`;
}

export async function renderCobros(env: Env): Promise<string> {
  const db = new Db(env.DB);
  const settings = await new SettingsRepo(db).all();
  const connected = stripeConfigured(env);
  const paymentsOn = settings[SETTING_KEYS.paymentsEnabled] === "1";

  const agg = await db.first<{ n: number; paid: number; pending: number; cur: string | null }>(
    `SELECT COUNT(*) n,
            COALESCE(SUM(CASE WHEN status='paid'    THEN amount END),0) paid,
            COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending,
            (SELECT currency FROM payment_intents ORDER BY created_at DESC LIMIT 1) cur
       FROM payment_intents`,
  );
  const rows = await db.all<PayRow>(
    `SELECT pi.id, pi.amount, pi.currency, pi.description, pi.status, pi.url,
            pi.created_at, pi.paid_at, pi.conversation_id,
            c.channel, c.channel_user_id
       FROM payment_intents pi
       LEFT JOIN conversations c ON c.id = pi.conversation_id
      ORDER BY pi.created_at DESC
      LIMIT 100`,
  );
  const cur = agg?.cur ?? "MXN";

  let body = "";

  if (!connected) {
    body += connectCard(
      "credit-card",
      "Conecta Stripe para empezar a cobrar",
      "Con tu propia cuenta de Stripe, el bot puede mandarle a un cliente un link de pago por WhatsApp y avisarte apenas paga. Tu llave nunca la vemos nosotros — vive cifrada en tu Cloudflare.",
    );
    body += `<div style="margin-bottom:16px">${renderConfigPrompt(
      CONFIG_PROMPT,
      "Pégale este mensaje a tu sesión de Claude Code en la carpeta del bot:",
    )}</div>`;
  } else if (!paymentsOn) {
    body += connectCard(
      "circle-alert",
      "Stripe conectado, pero Cobros sigue apagado",
      "Ya tienes la llave configurada. Falta prender el switch — dile a tu agente \"préndeme Cobros\" o corre el skill /cobros para confirmar y activarlo.",
    );
  }

  body += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
    ${statCard("Cobrado", money(agg?.paid ?? 0, cur), "Total confirmado por Stripe")}
    ${statCard("Pendiente", money(agg?.pending ?? 0, cur), "Links enviados, sin pagar aún")}
    ${statCard("Links generados", String(agg?.n ?? 0))}
  </div>`;

  if (rows.length === 0) {
    body += `<div class="bg-panel border border-line" style="padding:36px 18px;text-align:center">
      <p class="text-dim" style="font-size:12.5px">Aún no se ha generado ningún cobro.</p>
    </div>`;
  } else {
    const list = rows
      .map((r) => {
        const st = STATUS_MAP[r.status] ?? { label: r.status.toUpperCase(), color: "var(--muted)" };
        const when = new Date(r.status === "paid" && r.paid_at ? r.paid_at : r.created_at).toLocaleString(
          "es-MX",
          { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
        );
        const who = r.channel_user_id ? `${r.channel ?? ""} · ${r.channel_user_id.slice(-8)}` : "—";
        const desc = esc(r.description ?? "Cobro");
        const openConv = r.conversation_id
          ? `<a href="/admin/conversations?c=${encodeURIComponent(r.conversation_id)}" class="text-dim" style="font-size:11px" title="Ver la conversación">Ver chat</a>`
          : "";
        return `<div class="datarow bg-panel border border-line" style="padding:13px 16px;margin-bottom:8px;display:flex;align-items:center;gap:14px">
          <div style="min-width:0;flex:1">
            <div class="text-cream font-display font-semibold" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${desc}</div>
            <div class="text-dim" style="font-size:11px;margin-top:2px">${esc(who)} · ${when}</div>
          </div>
          <div class="font-mono text-cream" style="font-size:13.5px;font-weight:600;flex:none">${money(r.amount, r.currency)}</div>
          <span style="font-size:9px;letter-spacing:.05em;color:${st.color};border:1px solid ${st.color};padding:2px 7px;flex:none">${st.label}</span>
          <span style="flex:none">${openConv}</span>
        </div>`;
      })
      .join("");
    body += list;
  }

  const page = `
    <div class="card">
      <section>
        <h2 class="font-display font-semibold text-cream" style="font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px">
          <i data-lucide="wallet" width="17" height="17" style="color:var(--accent)"></i> Cobros por WhatsApp
        </h2>
        ${body}
      </section>
    </div>`;

  return layout({ title: "Cobros", activeTab: "cobros", body: page, env });
}
