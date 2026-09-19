import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { createPaymentLink, stripeConfigured } from "../integrations/stripe";

/**
 * Cobros por WhatsApp (superpoder Forja+ Pro, opt-in — skill /cobros) — el
 * bot genera un link de pago de Stripe y se lo manda al cliente. El webhook
 * POST /webhooks/stripe confirma cuando pagan y avisa al dueño por Telegram
 * (ver integrations/stripeWebhook.ts). Requiere STRIPE_SECRET_KEY (secret
 * del miembro, ver env.ts); sin él la tool no se registra (buildTools).
 *
 * El toggle payments_enabled (settings-loader.ts) es el gate REAL de opt-in:
 * aunque esta tool ya esté registrada (isPro + stripeConfigured), no aparece
 * en enabledToolNames hasta que el dueño confirme con el skill — mandar un
 * link de cobro es una acción de dinero, no algo que se prenda solo.
 */
export function sendPaymentLinkTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Genera un link de pago de Stripe para cobrarle a un cliente por WhatsApp. Úsalo cuando el cliente quiere pagar o confirmar una compra. Devuelve el link para mandárselo; el dueño recibe aviso cuando el pago se confirma.",
    inputSchema: z.object({
      amount: z.number().positive().describe("Monto a cobrar (ej. 250 = $250)"),
      currency: z.string().length(3).default("mxn").describe("Moneda ISO: mxn, usd…"),
      description: z.string().max(200).describe("Qué se está cobrando (ej. 'Corte + barba')"),
    }),
    execute: async ({ amount, currency, description }) => {
      if (!stripeConfigured(env)) return { error: "payments_not_connected" as const };

      const db = new Db(env.DB);
      const intentId = crypto.randomUUID();
      const conversationId = getConversationId();
      const now = Date.now();

      try {
        const { url, providerId } = await createPaymentLink(env, {
          amount,
          currency,
          description,
          intentId,
          conversationId: conversationId ?? undefined,
        });
        await db.run(
          `INSERT INTO payment_intents
             (id, conversation_id, amount, currency, description, provider, provider_id, url, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'stripe', ?, ?, 'pending', ?)`,
          [intentId, conversationId, Math.round(amount * 100), currency.toLowerCase(), description, providerId, url, now],
        );
        return { url, amount, currency: currency.toLowerCase(), description };
      } catch (e: any) {
        console.error("[cobros] createPaymentLink failed:", e);
        return { error: "payment_link_failed" as const, message: String(e?.message ?? e) };
      }
    },
  });
}
