---
name: reportes
description: Diseña el reporte diario del bot a la medida del negocio. PRIMERO pregunta su branding (colores, logo, vibra), LUEGO diseña un reporte hermoso con esa marca aplicando principios de diseño, y lo cablea. El motor del bot lo llena solo cada día con datos reales + insights que escribe la IA — el dueño recibe un resumen por Telegram con un link a la página completa con gráficas. Actívalo con "/reportes", "quiero reportes bonitos", "diseña mi reporte diario", "personaliza el reporte con mi marca".
---

# Reportes — un reporte diario que dé "wow", con la marca del negocio

Eres el diseñador del reporte diario del bot del miembro. Él NO programa: **tú le
preguntas su branding, diseñas un reporte precioso con SUS colores, y lo cableas**.
El bot ya trae un motor que cada mañana junta los datos reales del día y hace que
**la misma IA que atiende clientes escriba los insights** (resumen, hallazgos,
acciones). Tu trabajo es que ese reporte salga **con la identidad del negocio**, no
genérico.

Hablas español claro de dueño de negocio. El protagonista es **cómo se va a ver el
reporte**, no el código. SIGUE ESTAS REGLAS. Empieza por el PASO 0.

## Cómo llega hoy (dilo así, sin prometer de más)

- **Cada mañana** (cron `0 3 * * *`), si el dueño tiene el superpoder "Reporte diario"
  prendido, le llega un **DM de Telegram** con el resumen (números + lo que la IA
  vio + qué hacer mañana) y un link a **`/admin/report`** — la página COMPLETA, con
  gráficas, tendencia de 7 días, calificación del bot, temas frecuentes.
- La página vive en su panel — no hace falta login especial, ya está detrás del
  mismo Basic Auth del resto de `/admin`.
- **Email y PDF/Word NO están conectados todavía en este bot** — si el dueño los
  pide, ver el PASO 4 (tú los activas ahí, es trabajo real de código y, para PDF,
  requiere un plan de Cloudflare que habilite Browser Rendering).

## PASO 0 — Revisión (no edites nada)
1. Confirma que estás en la carpeta del bot: `package.json` con scripts `deploy`,
   `test`. Si no, detente y dilo.
2. `git status` (avisa si hay cambios sin guardar) + anota el commit actual.
3. Reportes diseñados es superpoder **Pro** — el reporte diario en sí (el envío por
   Telegram) también necesita el toggle `daily_report` prendido (por separado, ver
   skill `/human-in-the-loop` si aún no lo prendieron). Si el bot es free, avísale
   que esto es de Forja+, pero puedes diseñarlo igual para cuando suba.
4. Cuéntale en 2 líneas qué encontraste y arranca.

## PASO 1 — Branding (esto es lo primero, SIEMPRE)
Antes de diseñar nada, saca su identidad. Pregunta (2-3 cosas a la vez, con ejemplos):
- **Color principal de su marca** (hex o "el naranja de mi logo"). Si no sabe el hex,
  pídele el link de su web/IG y sácalo, o proponle 2-3 y que elija.
- **Logo**: ¿tiene una URL pública de su logo? (cuadrado ideal). Si no, se usa un
  monograma con sus iniciales — está bien.
- **Vibra**: ¿premium y sobrio? ¿cálido y cercano? ¿fresco y divertido? Esto guía la
  paleta secundaria y el tono de los textos fijos.
- **Nombre a mostrar** y giro (para que el diseño se sienta suyo).

Si te da poco, insiste con ejemplos — no inventes su marca.

## PASO 2 — Diseña el reporte con su marca
El motor llena una plantilla HTML con placeholders `{{X}}`. Trae una **default bonita**
ya lista. Tú tienes dos caminos (elige con el miembro):

**A) Rebrand rápido (lo más común):** deja la plantilla default y solo métele su
marca — guarda su color en `report_accent` y su logo en `report_logo`. Con eso el
reporte default sale con SUS colores y logo. Rápido y se ve muy bien.

**B) Diseño a la medida:** diseña una plantilla HTML propia (aplica buen diseño:
paleta de su marca, jerarquía tipográfica, un elemento firma, secciones limpias, y
**buena paginación** con `@media print` / `page-break-inside:avoid` para que se
imprima sin cortes feos si el dueño la guarda como PDF desde el navegador). Guarda
la plantilla en `report_template`. **Usa EXACTAMENTE estos placeholders** (el motor
los llena; los que no uses simplemente no salen):

  Texto/IA: `{{BUSINESS_NAME}}` `{{DATE_LABEL}}` `{{LOGO}}` `{{SUMMARY}}`
  `{{INSIGHT_BULLETS}}` (bloque HTML de hallazgos) `{{ACTIONS_ITEMS}}` (`<li>` de acciones)
  Números: `{{CUSTOMER_MESSAGES}}` `{{NEW_CONVERSATIONS}}` `{{NEW_LEADS}}` `{{HOT_LEADS}}`
  `{{D_MESSAGES}}` `{{D_CONVERSATIONS}}` `{{UPSET}}` `{{FOLLOWUPS_SENT}}`
  `{{REVIEWS_REQUESTED}}` `{{TICKETS}}` `{{STARS}}` `{{PEAK_HOUR}}` `{{TREND_DELTA}}`
  `{{SENT_CONTENTOS}}` `{{SENT_NEUTRALES}}` `{{SENT_FRUSTRADOS}}` `{{SENT_MOLESTOS}}`
  Gráficas (SVG/HTML ya renderizado, coloreado con `report_accent`): `{{DONUT}}`
  (tasa de resolución) `{{HOURLY}}` (actividad por hora) `{{SENTIMENT_BAR}}`
  `{{TREND}}` (7 días) `{{TOPIC_PILLS}}` `{{MISSED}}` (preguntas sin responder)
  Otros: `{{ACCENT}}` `{{PANEL_URL}}`

  Referencia viva: mira `src/owner/report/template.ts` (la default,
  `DEFAULT_REPORT_TEMPLATE`). Copia su estructura y re-brándéala; NO reinventes
  los placeholders.

Guarda los settings con un archivo .sql (el template es largo; duplica `'` → `''`):
```
# report.sql
INSERT INTO settings (key, value, updated_at) VALUES
 ('report_accent', '#HEXDELCLIENTE', strftime('%s','now')*1000),
 ('report_logo', 'https://.../logo.png', strftime('%s','now')*1000)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
```
```
wrangler d1 execute DB --remote --file=report.sql
```
(Para `report_template` custom, mismo patrón con el HTML completo.)

## PASO 3 — Previsualiza y valida
1. `pnpm test` — que nada se rompa.
2. **Vista previa sin esperar a las 3am:** abre `https://<worker>.workers.dev/admin/report`
   en su panel (arma un reporte fresco al vuelo con los datos reales de hoy —
   siempre está "en vivo", cada visita gasta una llamada de IA para los insights).
   Enséñale cómo quedó.
3. Ajusta color/logo/plantilla hasta que diga "así lo quiero".

## PASO 4 — Email, DOCX o PDF adjunto (solo si lo pide, es trabajo nuevo)
Hoy el bot solo entrega el DM de Telegram + la página. Si el dueño quiere ALGO MÁS:

- **Email:** este bot trae `resend` como dependencia pero SIN wirear para esto
  todavía. Tendrías que: pedirle su `RESEND_API_KEY` (secret), y en
  `src/owner/dailyReport.ts` (o donde decidas engancharlo) mandar
  `report.emailHtml` (ya lo genera `buildReport()`, en `src/owner/report/template.ts`
  vía `renderReportEmail`) por la API de Resend, junto al envío de Telegram que ya
  existe. Avísale que es trabajo de código nuevo, no un toggle.
- **DOCX:** `npm i docx`. Implementa `renderReportFile` en
  `src/owner/report/file.ts` (hoy devuelve `null` — placeholder a propósito) para
  `format === "docx"`: arma el documento con la lib (título, KPIs en tabla,
  insights, acciones) y devuelve `Packer.toBuffer(...)` como `Uint8Array`. Es
  pura-JS, corre en el Worker.
- **PDF:** `npm i @cloudflare/puppeteer` y agrega el binding en `wrangler.toml`:
  `[browser]\n binding = "BROWSER"`. En `renderReportFile` para `pdf`, lanza
  puppeteer con `env.BROWSER`, `page.setContent(input.html)`,
  `page.pdf({format:'A4'})`. **Requiere un plan de Cloudflare que habilite Browser
  Rendering** — díselo al miembro ANTES de prometerlo.

Si implementas cualquiera de estos, `pnpm test` de nuevo y recuérdale que
**necesita `pnpm run deploy`** (código nuevo no aplica en caliente, a diferencia de
`report_accent`/`report_logo`/`report_template`, que SÍ son settings en vivo).

## PASO 5 — Cierre
- Los settings (`report_accent`, `report_logo`, `report_template`) aplican **en
  vivo**, sin redeploy.
- Si tocaste código (PASO 4), eso **NO está en vivo hasta desplegar** — recuérdale
  correr `pnpm run deploy`. **NUNCA deployes ni hagas push tú.**
- Cierra con un antes/después: enséñale el link de `/admin/report` y qué recibirá
  cada mañana por Telegram.

## Nota técnica (para ti, no para el miembro)

- Motor: `src/owner/report/collect.ts` (datos), `insights.ts` (IA, vía `workModel`
  del bot — mismo failover que el resto del bot), `template.ts` (diseño +
  render), `build.ts` (`buildReport`/`reportSnapshot`/`reportMarkdown`).
- `src/owner/dailyReport.ts` es el ÚNICO caller de producción hoy: llama
  `buildReport()`, manda `report.text` por Telegram, y guarda
  `reportSnapshot(report, now)` en el setting `report_last_json` (lo sirve
  `GET /api/report/latest` para Forja Inbox, sin gastar otra llamada de IA).
- `/admin/report` (routes.ts) SIEMPRE regenera en vivo (gasta una llamada de IA
  por visita) — es Pro-gated (`PRO_GATE` en routes.ts, `PRO_ONLY_TABS` en
  config.ts). Devuelve la página COMPLETA (`report.html`), sin el shell del
  panel (`layout()`) — es un documento autocontenido.
