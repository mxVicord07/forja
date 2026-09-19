---
name: boveda
description: Superpoder Bóveda (Forja+) — guarda las imágenes y documentos que los clientes le mandan al bot (fotos para cotizar, comprobantes, PDFs) en el R2 del miembro, para verlos en el panel. El miembro NO programa; tú creas el bucket, conectas el binding, prendes el superpoder y despliegas. Actívalo con "/boveda", "activa la Bóveda", "quiero ver las imágenes que me mandan", "dónde veo las fotos de mis clientes", "guarda los documentos que me mandan", "que se guarden las imágenes del chat".
---

# Bóveda — guarda y muestra las imágenes/documentos del cliente

Eres el ingeniero del chatbot del miembro. Él NO programa: **tú corres todos los comandos**.
La Bóveda archiva las imágenes y documentos que los clientes le mandan al bot (que hoy se
pierden: las URLs de WhatsApp/Telegram expiran) en el **R2 del propio miembro**, y las muestra
en el panel — pestaña **Bóveda** (`/admin/boveda`). Caso estrella: cotizar por foto.

Es un superpoder **Forja+ (Pro)**. Si el bot es Starter, no aplica (ver PASO 0).

SIGUE ESTAS REGLAS AL PIE DE LA LETRA. **Fail-safe:** nada de esto puede borrar datos del
miembro — solo AGREGA un bucket, un binding y una tabla nueva.

## PASO 0 — Revisión y nivel (no toques nada todavía)

1. Confirma que estás en la carpeta del bot: deben existir `package.json` y `wrangler.toml`.
2. Confirma el tier:
   ```bash
   grep BOT_TIER wrangler.toml
   ```
   Si dice `free`, explícale que la Bóveda es Forja+ y ofrécele el upgrade (horizontesia.com)
   — no la prendas a la fuerza.
3. Revisa si ya tiene el binding `MEDIA` en `wrangler.toml` (`grep -A2 'binding = "MEDIA"'`).
   Si ya existe, salta al PASO 2.

## PASO 1 — Explica y pregunta (opt-in de verdad)

> "Te activo la **Bóveda**: las fotos y documentos que tus clientes te manden por el bot
> (para pedirte cotización, mandarte un comprobante, etc.) se van a guardar de verdad —
> hoy esos links caducan y se pierden. Vas a poder verlos en tu panel, dentro de cada
> conversación. ¿Le entramos?"

Espera su sí. Si dice que no, no toques nada.

## PASO 2 — Crea el bucket R2 (en SU cuenta de Cloudflare)

```bash
npx wrangler r2 bucket create horizontes-bot-media-<slug-del-bot>
```

Usa un nombre único por bot (mismo criterio que el D1/Vectorize — ver "Reglas de
seguridad" del skill `forja`: nunca reuses el bucket de otro bot).

## PASO 3 — Conecta el binding en `wrangler.toml`

Agrega (si no existe ya) junto a los demás bindings de R2 (`CATALOG`):

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "horizontes-bot-media-<slug-del-bot>"
```

## PASO 4 — Prende el switch y despliega

```bash
wrangler d1 execute DB --remote --command "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('boveda_enabled', '1', $(( $(date +%s) * 1000 )));"
pnpm run deploy
```

El deploy es OBLIGATORIO acá (a diferencia de Botones): el binding `MEDIA` de
`wrangler.toml` solo toma efecto con un redeploy — no es un setting en caliente.

## PASO 5 — Pruébalo con él

Que le mande al bot por su canal principal una foto (o una nota de voz/documento). Después
abre `https://<worker>.workers.dev/admin/boveda` (o el tab **Bóveda** del panel) y confirma
que aparece. Tócala para confirmar que abre el archivo real.

## Apagarla (sin borrar lo ya guardado)

```bash
wrangler d1 execute DB --remote --command "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('boveda_enabled', '0', $(( $(date +%s) * 1000 )));"
```

## Reglas duras

- **Opt-in siempre**: nunca la prendas sin su sí explícito, y nunca en un bot Starter.
- **El bucket es de ESE bot, nunca compartido** — mismo criterio que D1/Vectorize.
- Solo archiva lo que el CLIENTE manda (`direction='in'`) — nunca expone esos archivos por
  una URL pública: se sirven tras el Basic Auth del panel (`/admin/media/:id`).
- Tope de 20 MB por archivo (protege el R2 del miembro de un archivo gigante).

## Nota técnica (para ti, no para el miembro)

- La captura corre en `src/agent.ts#ingest` (`captureIncomingMedia`, de
  `src/media/boveda.ts`), gateada por `boveda_enabled` Y tier Pro
  (`resolveAgentConfig().bovedaEnabled`). Fail-open: si R2 falla o la URL ya
  expiró, el turno del bot sigue igual, solo no se archiva.
- El tab del panel es `src/admin/views/boveda.ts`, montado en
  `adminApp.get("/boveda", …)` — mismo Basic Auth que el resto de `/admin`.
- Sin el binding `MEDIA` (`env.MEDIA` ausente), `captureIncomingMedia` es un
  no-op silencioso — prender el setting sin desplegar el binding no rompe
  nada, simplemente no archiva todavía.
