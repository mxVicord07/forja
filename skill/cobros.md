---
name: cobros
description: Superpoder Cobros por WhatsApp (Forja+) — el bot genera un link de pago de Stripe y se lo manda al cliente cuando quiere pagar o confirmar una compra; el dueño recibe aviso por Telegram apenas se confirma el pago. El miembro NO programa; tú conectas su llave de Stripe, configuras el webhook, y prendes el superpoder. Actívalo con "/cobros", "activa Cobros", "quiero cobrar por WhatsApp", "que el bot mande links de pago", "conecta Stripe a mi bot", "cómo cobro a mis clientes por el chat".
---

# Cobros — el bot cobra por WhatsApp con Stripe

Eres el ingeniero del chatbot del miembro. Él NO programa: **tú corres todos los comandos**.
Cobros deja que el bot le mande a un cliente un link de pago de Stripe en plena conversación
— el cliente paga, el dueño recibe aviso, y el bot puede confirmarle "ya vi tu pago" en el
mismo chat.

Es un superpoder **Forja+ (Pro)**, **opt-in de verdad** (viene apagado aunque ya haya llave
conectada — cobrar es una acción de dinero, no algo que se prenda solo). Si el bot es
Starter, no aplica.

SIGUE ESTAS REGLAS AL PIE DE LA LETRA. **Fail-safe:** nada de esto puede mover dinero del
miembro — la llave de Stripe es SUYA, a SU cuenta; tú solo conectas cables.

## PASO 0 — Revisión y nivel (no toques nada todavía)

1. Confirma que estás en la carpeta del bot: deben existir `package.json` y `wrangler.toml`.
2. Confirma el tier (`grep BOT_TIER wrangler.toml`). Si dice `free`, explícale que Cobros es
   Forja+ y ofrécele el upgrade (horizontesia.com) — no lo prendas a la fuerza.
3. Revisa si ya tiene los secrets de Stripe:
   ```bash
   npx wrangler secret list
   ```
   Busca `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`. Si ya están, salta al PASO 3.

## PASO 1 — Explica y pregunta (opt-in de verdad)

> "Te activo **Cobros**: tu bot va a poder mandarle a un cliente un link de pago de Stripe
> ('págame $250 por el corte') y avisarte por Telegram en cuanto pague — sin que tengas que
> preguntar 'ya depositaste?'. El dinero llega DIRECTO a tu cuenta de Stripe, nunca pasa por
> nosotros. ¿Tienes cuenta de Stripe, o te ayudo a crear una?"

Si no tiene cuenta, mándalo a stripe.com/mx (o el dominio de su país) a crear una — toma
unos minutos, solo pide datos básicos del negocio para empezar en modo test.

## PASO 2 — Conecta la llave secreta de Stripe

Pídele su llave secreta (Dashboard de Stripe → Developers → API keys → "Secret key",
empieza con `sk_live_...` en modo real o `sk_test_...` en modo prueba). **Dile que la pegue
en SU TERMINAL, no en el chat** — si de todos modos te la pega acá, adviértele y tú mismo la
guardas sin volver a mostrarla:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

Recomiéndale arrancar en modo TEST (`sk_test_...`) y hacer un cobro de prueba antes de pasar
a modo LIVE — así se prueba todo el flujo sin dinero real.

## PASO 3 — Configura el webhook de confirmación de pago

En el Dashboard de Stripe → Developers → Webhooks → "Add endpoint":
- URL: `https://<worker>.workers.dev/webhooks/stripe`
- Eventos a escuchar: `checkout.session.completed` y `payment_intent.succeeded`

Al crearlo, Stripe muestra un "Signing secret" (`whsec_...`) — pídeselo y guárdalo:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

## PASO 4 — Redespliega y prende el switch

El secret nuevo necesita que el Worker se reinicie con él disponible:

```bash
pnpm run deploy
wrangler d1 execute DB --remote --command "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('payments_enabled', '1', $(( $(date +%s) * 1000 )));"
```

## PASO 5 — Asegura el aviso al dueño

El aviso de "te pagaron" sale por **Telegram DM** (el mismo canal que los tickets de
handoff) — confirma que `TELEGRAM_BOT_TOKEN` y `OWNER_TELEGRAM_CHAT_ID` ya están
configurados (si el bot ya tiene handoff funcionando, ya los tiene). Sin esos dos, el pago
SÍ se confirma y se guarda, pero nadie se entera — avísale de esto explícitamente.

## PASO 6 — Pruébalo con él (en modo TEST primero)

Con `sk_test_...` conectado, que le escriba al bot algo como *"quiero pagar el servicio"* y
confirma que:
1. El bot manda un link de pago real de Stripe.
2. Al pagar con una [tarjeta de prueba de Stripe](https://docs.stripe.com/testing) (ej.
   `4242 4242 4242 4242`, cualquier fecha futura, cualquier CVC), el dueño recibe el aviso
   de Telegram en segundos.
3. Abre `https://<worker>.workers.dev/admin/cobros` (o el tab **Cobros** del panel) y
   confirma que el cobro aparece como "Pagado".

Solo después de una prueba exitosa en TEST, ayúdalo a cambiar `STRIPE_SECRET_KEY` a su llave
`sk_live_...` y crear el webhook equivalente apuntando también en modo LIVE.

## Apagarlo (sin borrar el historial de cobros)

```bash
wrangler d1 execute DB --remote --command "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('payments_enabled', '0', $(( $(date +%s) * 1000 )));"
```

## Reglas duras

- **Opt-in siempre**: nunca lo prendas sin su sí explícito, y nunca en un bot Starter.
- **La llave es SUYA**: nunca la pegues en el chat de vuelta, nunca la guardes en un
  archivo del repo — solo como secret de Cloudflare.
- El bot **nunca** inventa un monto — cada link sale de lo que el cliente y el bot acordaron
  en la conversación (o de tus `custom_instructions` si le diste precios fijos).
- El webhook es la ÚNICA fuente de verdad de "pagó de verdad" — el bot nunca marca algo como
  pagado por su cuenta.

## Nota técnica (para ti, no para el miembro)

- Tool: `src/tools/cobros.ts` (`sendPaymentLinkTool`), registrada en `buildTools()` solo si
  `stripeConfigured(env)` (Pro + `STRIPE_SECRET_KEY`) — pero el opt-in REAL vive en
  `settings-loader.ts` (`enabledToolNames`): la tool queda fuera de lo que el modelo puede
  llamar hasta que `payments_enabled === "1"`.
- Integración: `src/integrations/stripe.ts` (Payment Links API) +
  `src/integrations/stripeWebhook.ts` (verifica firma, marca `payment_intents.status='paid'`,
  avisa por Telegram — NO usa `notifyOwner` de `handoffHuman.ts` porque ese canal de Twilio
  WhatsApp exige una Content Template aprobada pensada para tickets, no para pagos).
- Tabla: `payment_intents` (en `schema.sql`, no lazy — instalaciones existentes necesitan
  `wrangler d1 execute --file schema.sql --remote` una vez antes de prender el superpoder).
- Panel: `src/admin/views/cobros.ts`, tab Pro-gated en `PRO_ONLY_TABS`.
- `payments` SÍ vive en `SUPERPOWERS` (`settings-mutations.ts`) — a diferencia de Botones y
  Bóveda, es visible/toggleable desde Forja Inbox (`GET /api/config` /
  `GET /api/maintenance`), igual que Blindaje o Cazador de ventas.
