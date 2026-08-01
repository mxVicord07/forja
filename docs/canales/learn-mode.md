# Learn-mode — captura de payloads para inferir el mapeo de un canal

Este documento es la referencia de por qué la feature existe, por qué está
apagada por defecto, cómo encenderla si hace falta, y qué falta para
completarla. Escrito para quien retome esto sin haber estado presente en su
diseño original.

## Qué es y qué problema resuelve

Cada canal que el bot entiende tiene un contrato de webhook distinto (IDs,
texto, adjuntos de audio/imagen, canal de origen viven en rutas distintas del
JSON). Hoy esos contratos están **hardcodeados** por adapter: `manychat.ts`,
`whatsapp.ts`, `ycloud.ts`, `meta.ts`, `twilio.ts`, `telegram.ts` cada uno sabe
de memoria dónde vive cada campo para SU proveedor.

Learn-mode es la alternativa a hardcodear un contrato más: en vez de leer la
documentación de un proveedor nuevo y adivinar la forma de su payload, se
prende la captura, se le pega al bot un webhook real, y se guarda el payload
crudo tal cual llegó. De ahí se podría **inferir** un `LearnedMapping` (rutas
tipo `body.id`, `attachments.0.payload.url`, ver
`src/learn/mapping.ts::LearnedMapping`) sin que nadie tenga que adivinar la
forma del JSON de antemano. `src/channels/learned.ts` (`makeLearnedAdapter`)
es el adapter genérico pensado para consumir ese mapeo aprendido.

## Por qué está apagada

La cadena está **incompleta**: el lado de escritura funciona, el lado de
lectura no existe.

- `POST /webhooks/learn/:channel` (`src/index.ts`) captura el payload crudo a
  la tabla `settings` de D1 vía `saveCapture` — esto sí funciona.
- Pero **nadie lee jamás lo capturado**:
  - `loadCapture` (`src/learn/mapping.ts`) no tiene ningún llamador en todo
    el repo.
  - `saveLearnedMapping` (`src/learn/mapping.ts`) tampoco tiene ningún
    llamador — no hay ningún punto del código que derive un `LearnedMapping`
    a partir de una captura y lo guarde.
  - Ninguna vista de `src/admin/views/` referencia ninguna de las dos rutas
    de learn-mode ni expone el payload capturado. El panel no tiene forma de
    mostrarte lo que capturaste.
- Encima, `POST /webhooks/learn/:channel` **no valida firma** — cualquiera
  que sepa la URL y el nombre del canal puede escribir en `settings` mientras
  learn-mode esté encendido para ese canal. La única mitigación es la ventana
  de expiración (`isLearnMode`, tope de 60 minutos vía `LEARN_MAX_MINUTES`).

Neto: mantenerla alcanzable en producción sin gate era superficie de ataque
permanente a cambio de capacidad cero (nada consume lo que se captura). Por
eso `LEARN_MODE_ENABLED` (ver `src/env.ts`) la apaga por defecto — el código
queda intacto y listo para completarse, pero no corre salvo que alguien la
prenda a propósito.

## Cómo encenderla hoy si hace falta

1. **Prender el gate.** En `wrangler.toml` (o `wrangler secret put` si se
   prefiere no dejarlo en el repo):

   ```toml
   [vars]
   LEARN_MODE_ENABLED = "1"
   ```

   Acepta `"1"` o `"true"` (insensible a mayúsculas, con espacios). Cualquier
   otro valor, o la ausencia de la var, la deja apagada.

2. **Desplegar** con el gate prendido (`pnpm deploy` o `wrangler deploy`).

3. **Encender la captura para el canal** (requiere Basic Auth del panel
   admin — usuario `admin`, la contraseña de `DASHBOARD_PASSWORD` — y
   `Content-Type: application/json`, si no el endpoint responde 415):

   ```bash
   curl -u admin:<DASHBOARD_PASSWORD> \
     -X POST https://<worker>.workers.dev/admin/learn/<channel>/start \
     -H "Content-Type: application/json" \
     -d '{"minutes": 15}'
   ```

   `<channel>` debe ser uno de los `ChannelId` reconocidos (`whatsapp`,
   `instagram`, `messenger`, `telegram`, `twilio`, `manychat`). `minutes` es
   opcional (default 15, tope 60 — `LEARN_MAX_MINUTES` en
   `src/admin/routes.ts`).

4. **Disparar el webhook real** del proveedor que se quiere capturar (o
   simularlo con curl) apuntando a `POST /webhooks/learn/<channel>` con el
   payload real. Mientras learn-mode esté encendido para ese canal, el
   endpoint responde `{ok:true, captured:"<kind>", channel}` y guarda el
   payload crudo — `kind` es `"audio"`, `"image"` o `"text"` según
   `detectKind` (`src/learn/fieldPath.ts`).

5. **Apagar la captura** cuando ya se tiene el payload (no hace falta esperar
   a que expire; `stop` funciona siempre, incluso si luego se apaga el gate):

   ```bash
   curl -u admin:<DASHBOARD_PASSWORD> \
     -X POST https://<worker>.workers.dev/admin/learn/<channel>/stop \
     -H "Content-Type: application/json"
   ```

6. **Leer lo capturado.** No hay vista de panel (ver siguiente sección), así
   que hoy la única forma es leer directo de D1. Las keys siguen el patrón
   `learn:<channel>:<kind>` en la tabla `settings`:

   ```bash
   wrangler d1 execute horizontes_bot_db --remote --command \
     "SELECT value FROM settings WHERE key = 'learn:whatsapp:text'"
   ```

   `value` es el JSON del payload crudo, tal cual llegó al webhook.

## Qué falta para completarla (la ruta a la opción C)

Checklist accionable, en el orden en que tiene sentido hacerlo:

- [ ] **Vista del panel que muestre la captura.** Cablear `loadCapture`
      (`src/learn/mapping.ts`) a una vista nueva en `src/admin/views/` (o una
      sección dentro de una existente) que liste, por canal, lo capturado
      (`learn:<channel>:audio|image|text`) en crudo o formateado.
- [ ] **Derivar y guardar un `LearnedMapping`.** Alguna forma (manual desde
      el panel — el operador marca qué campo es cuál — o heurística
      automática) de convertir el payload capturado en un `LearnedMapping` y
      persistirlo con `saveLearnedMapping` (`src/learn/mapping.ts`).
- [ ] **Conectar con `makeLearnedAdapter`.** Verificar que el mapeo guardado
      efectivamente alimenta `src/channels/learned.ts` — mirar cómo
      `makeLearnedAdapter` consume `loadLearnedMapping` (fallback a ManyChat
      si no hay mapeo) y confirmar que un mapeo recién guardado se recoge sin
      pasos manuales adicionales.
- [ ] **Verificación de firma (o algún control) en el endpoint de
      captura.** `POST /webhooks/learn/:channel` sigue sin validar firma; hoy
      la única mitigación es la ventana de expiración + el gate de env. Antes
      de dejar esto encendible sin supervisión constante, agregar algo más
      fuerte que la ventana de tiempo (firma HMAC compartida, allowlist de
      IP, o similar).

## Cuándo tiene sentido hacerlo

Cuando aparezca un proveedor nuevo cuyo contrato de webhook **no se quiera
hardcodear** de antemano — por ejemplo, porque no hay forma barata de obtener
un payload real de otra manera.

**Precedente útil (y por qué NO hizo falta acá):** para el adapter de YCloud
(`src/channels/ycloud.ts`, ver `docs/canales/ycloud.md`) no fue necesario
prender learn-mode. El payload real se obtuvo directo del historial de
ejecuciones de n8n del canal ya operando
(`docs/superpowers/specs/ycloud-payloads-capturados.json`), que resultó una
vía más barata y sin exponer un endpoint sin firma en producción. Learn-mode
tiene sentido cuando esa vía (tráfico real ya fluyendo por otro sistema) no
existe.
