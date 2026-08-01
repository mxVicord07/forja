# Adapter de WhatsApp vía YCloud — Diseño

> 2026-08-01 · Proyecto FORJA (BIRevX) · fork `mxVicord07/forja`

## Problema

El bot `birevx-support-bot` corre en producción con dos canales (Telegram e
Instagram DMs). Falta WhatsApp, que es el canal principal cara al cliente.

El fork ya trae `src/channels/whatsapp.ts`: un adapter completo de **WhatsApp
Cloud API directo de Meta**, con proxy de media firmado y verificación de firma.
No se puede usar todavía: exige `WHATSAPP_PHONE_NUMBER_ID` y
`WHATSAPP_ACCESS_TOKEN`, que solo se obtienen operando la WABA directamente
contra Meta. Eso requiere Verificación de Negocio ante Meta, hoy bloqueada por
un asunto fiscal/legal sin resolver (BIRevX es nombre comercial, no persona
moral; pendiente consulta con especialista SAT/Meta).

Mientras tanto, la WABA `1298715852276116` (número **+52 444 423 7875**) la
opera **YCloud** como BSP. YCloud no expone credenciales de Meta — se verificó
en su panel de Integraciones que no existe opción de "traer tu propia app" ni de
passthrough de Cloud API. Su API es propietaria. Por lo tanto hace falta un
adapter nuevo.

### Restricción descubierta: el número ya está ocupado

El panel de Webhooks de YCloud tiene un único endpoint activo:

```
https://n8n.birevx.com/webhook/66aac0b3a7cf4a408fa18b93f93ba745
"WAB Asistente Operativo BIRevX - LIA"
```

Todo el WhatsApp entrante lo consume hoy el workflow de LIA en n8n. YCloud
permite varios endpoints, pero dos consumidores activos = **el cliente recibe
dos respuestas**. Es el mismo problema que Forja ya resolvió en Instagram con el
flag `IG_DM_SOURCE=manychat` (`src/index.ts:121`).

Esto crea una dependencia circular con la cláusula de excepción vigente ("pausar
LIA cuando WhatsApp-Forja esté operativo"): Forja no puede llegar a operativo
sin tocar el número de LIA. Este diseño rompe la circularidad con una etapa de
observación que no responde nada.

## No incluido en este alcance

- Migración del número a Cloud API directo (Etapa C — se habilita, no se ejecuta).
- Pausa definitiva de LIA ni el corte de producción (Etapa B).
- Auditoría del workflow de LIA (`8E0Y7ap8iMBxWREA`) — se hace desde el
  workspace "Consultor BIRevX AAIA", que sí tiene `n8n-mcp`.
- Plantillas HSM / mensajes fuera de la ventana de 24h.
- Puente Forja → CRM.

## Estrategia: tres etapas sobre el mismo número

| Etapa | `WA_PROVIDER` | Webhooks en YCloud | LIA | Forja |
|---|---|---|---|---|
| **A. Sombra** (este spec) | — | LIA + `/webhooks/learn/whatsapp` | Operando | Solo captura, no responde |
| **B. Corte** | `ycloud` | solo `/webhooks/whatsapp` | Pausada | Operando |
| **C. Salida** | `meta` | ninguno (webhook en Meta) | Pausada | Operando vía `whatsapp.ts` |

Este spec entrega el código completo del adapter y ejecuta **solo la Etapa A**.
B y C quedan habilitadas por configuración, sin cambios de código.

### Decisión: `channel: "whatsapp"` compartido entre proveedores

Ambos adapters emiten `channel: "whatsapp"`. No se agrega `"ycloud"` al union
`ChannelId`.

**Razón principal:** el Durable Object se direcciona con
`${msg.channel}:${msg.channelUserId}` (`src/index.ts:32`). Un id de canal
distinto significaría que en el corte B→C cada cliente amanece sin historial de
conversación.

Secundarias: no toca tipos existentes (`shared.ts`, `labels.ts`, insights,
system prompt) — el adapter es puramente aditivo; y es semánticamente correcto,
porque el canal *es* WhatsApp: quién lo transporta es detalle de
infraestructura, y la procedencia queda en `rawPayload`.

**Costo aceptado:** el panel no puede distinguir proveedor en métricas. Como
nunca corren los dos a la vez sobre el mismo número, no importa.

### Decisión: normalizar `channelUserId` a dígitos sin `+`

Los dos proveedores formatean el teléfono distinto:

- Meta Cloud API entrega `from` como dígitos sin prefijo: `524444237875`.
- YCloud usa E.164 con `+`: `+524444237875`.

Si el adapter de YCloud propagara el `+` tal cual, el DO sería
`whatsapp:+524444237875` en Etapa B y `whatsapp:524444237875` en Etapa C — y la
continuidad de historial que motivó el channel id compartido se perdería de
todos modos.

**Regla:** el adapter de YCloud normaliza el entrante quitando `+` y cualquier
no-dígito, y vuelve a anteponer `+` al enviar (YCloud lo exige en `to`). El
formato canónico interno son dígitos pelones, que es el que ya usa
`whatsapp.ts`.

## Componentes

### 1. `src/channels/ycloud.ts` (nuevo)

Paridad funcional con `whatsapp.ts`: texto, imagen y audio.

**`verifyYCloudSignature(raw, header, secret) → Promise<boolean>`**
YCloud firma con el header `YCloud-Signature: t=<unix_segundos>,s=<hmac_hex>`,
donde el HMAC-SHA256 se calcula sobre `` `${t}.${raw}` ``. Diferencias contra
Meta que el código debe respetar:

- No hay handshake GET. La verificación es solo en POST.
- La firma incluye timestamp, así que **se valida antigüedad**: se rechaza si
  `|now - t| > 5 min` (ventana anti-replay). Meta no lo necesita porque su firma
  no lleva `t`; aquí ignorarlo sería negligente.
- Comparación timing-safe, fail-closed si falta el secret.

**`parseYCloudEvent(body, env, origin) → Promise<IncomingMessage | null>`**

- Filtra por `body.type === "whatsapp.inbound_message.received"`. YCloud entrega
  también eventos de estado/entrega al mismo endpoint (equivalente a
  `value.statuses[]` en Meta); se ignoran devolviendo `null`.
- Un evento = un mensaje. A diferencia de Meta, no hay batching, así que la
  firma devuelve un único mensaje y no un array.
- Devuelve `null` en vez de lanzar cuando el evento no es procesable —
  `whatsapp.ts` lanza, y eso obligaría a envolver cada llamada en try/catch para
  no responder 500 a un evento de status perfectamente normal.
- Mapeo:

  | Campo interno | Ruta en el payload |
  |---|---|
  | `channelUserId` | `whatsappInboundMessage.from` → normalizado a dígitos |
  | `displayName` | `whatsappInboundMessage.customerProfile.name` |
  | `text` | `whatsappInboundMessage.text.body` (o `image.caption`) |
  | `imageUrl` | proxy firmado sobre `image.link` |
  | `audioUrl` | proxy firmado sobre `audio.link` |

- `channel: "whatsapp"`, `isOwnerMessage: false`, `rawPayload` = el evento.
- **Estado real post-implementación (ver Ejecución):** no hizo falta la
  ventana de captura de la Etapa A para el texto — el payload de **texto** se
  confirmó contra 19 ejecuciones reales del historial de n8n del webhook de
  LIA (ver `docs/superpowers/specs/ycloud-payloads-capturados.json` y
  `docs/canales/learn-mode.md`), y la fila `text` de la tabla de arriba sale
  de ahí, no de la documentación. **`image` y `audio`: verificados el
  2026-08-01.** Se encendió `LEARN_MODE_ENABLED` temporalmente, se mandó una
  foto con caption y una nota de voz (~11s) al número de producción, y se
  leyeron los payloads capturados directo de D1 (`learn:whatsapp:image`,
  `learn:whatsapp:audio`). La forma coincide con la hipótesis original
  (`whatsappInboundMessage.image = {link, caption, id}` y
  `.audio = {link, id}`) — ver
  `docs/superpowers/specs/ycloud-payloads-capturados.json` para los payloads
  completos y `test/channels/ycloud.test.ts` para los tests que los usan como
  fixtures.

**Proxy de media: `signedMediaUrl()` + `serveYCloudMedia()`**
YCloud entrega `link` como URL directa, pero su descarga exige el header
`X-API-Key`. Como `transcribe`/`vision` reciben una URL y la bajan sin
credenciales, hace falta el mismo proxy firmado que usa Meta:

- `signedMediaUrl(link, env, origin)`: HMAC sobre `` `${link}.${exp}` `` con
  `YCLOUD_WEBHOOK_SECRET`, TTL 10 min, devuelve
  `/webhooks/whatsapp/media?u=<link>&exp=&sig=`.
- Diferencia con Meta: allá se firma un `media_id` opaco y el server resuelve la
  URL contra Graph; aquí ya tenemos la URL, así que se firma la URL misma. Para
  evitar convertir el proxy en un SSRF abierto, `serveYCloudMedia` **valida que
  el host sea `api.ycloud.com`** además de la firma. Sin esa validación, quien
  obtuviera el secret podría hacer que el Worker bajara cualquier URL.
- Descarga con `X-API-Key`, devuelve los bytes con su `Content-Type`.

**`ycloudAdapter.sendReply(reply, env)`**
`POST https://api.ycloud.com/v2/whatsapp/messages`, header `X-API-Key`, body:

```json
{ "from": "+524444237875", "to": "+52...", "type": "text",
  "text": { "body": "...", "preview_url": false } }
```

Mismo loop de chunks con `interChunkDelayMs` que los demás adapters. En error:
`console.error` con el cuerpo de la respuesta, **sin lanzar** — fuera de la
ventana de 24h Meta rechaza texto libre y no queremos tumbar el turno completo.

### 2. `src/channels/shared.ts` (refactor mínimo)

Subir `hmacHex()` y `timingSafeEqual()`, hoy privados en `whatsapp.ts`, para que
ambos adapters los compartan. `whatsapp.ts` pasa a importarlos. Es el único
cambio a código de canal existente y es mejora puntual del código que estamos
tocando, no refactor especulativo.

### 3. `src/index.ts` (despacho por proveedor)

`POST /webhooks/whatsapp` elige rama según `env.WA_PROVIDER`:

- `"ycloud"` → `verifyYCloudSignature` + `parseYCloudEvent` (0 o 1 mensaje).
- `"meta"` (default) → comportamiento actual sin cambios.

`GET /webhooks/whatsapp` (handshake `hub.challenge`) solo tiene sentido con
`meta`; con `ycloud` responde 404.

Las rutas de media son **dos, distintas**, no una con despacho — porque lo que
se firma es distinto (Meta firma un `media_id` opaco; YCloud firma una URL):

- `GET /webhooks/whatsapp/media/:id` — la existente, Meta, sin cambios.
- `GET /webhooks/whatsapp/media?u=<link>&exp=&sig=` — nueva, YCloud.

No colisionan en Hono (una tiene segmento de path, la otra no), y cada adapter
genera solo la suya, así que ambas pueden coexistir registradas.

### 3b. `src/replies/sender.ts` — `pickAdapter` necesita `env`

Consecuencia directa del channel id compartido, detectada al planear: el
despacho de `index.ts` solo cubre la **entrada**. La **salida** pasa por
`pickAdapter(channel)` (`src/replies/sender.ts:38`), que resuelve
`"whatsapp"` → `whatsappAdapter` (Meta) mirando únicamente el channel id.

Con `WA_PROVIDER=ycloud` eso produce el peor síntoma posible: el mensaje entra
bien por YCloud, el LLM responde, y el envío falla contra Meta por falta de
`WHATSAPP_PHONE_NUMBER_ID`. El bot recibe y nunca contesta.

**Cambio:** `pickAdapter(channel: ChannelId, env: Env): ChannelAdapter`. Para
`"whatsapp"` devuelve `ycloudAdapter` o `whatsappAdapter` según
`env.WA_PROVIDER`; el resto de canales no cambia.

Los 5 call sites de producción ya tienen `env` en el scope inmediato, así que es
mecánico:

| Sitio | Variable disponible |
|---|---|
| `src/agent.ts:106` | `this.env` |
| `src/agent.ts:426` | `this.env` |
| `src/campaigns.ts:144` | `env` |
| `src/followup/run.ts:177` | `env` |
| `src/admin/routes.ts:563` | `c.env` |

Tests afectados que hay que actualizar: `test/replies/sender.test.ts` (llama
`pickAdapter(ch)` directo) y `test/admin/inbox.test.ts:123`
(`expect(pickAdapterMock).toHaveBeenCalledWith("telegram")` pasa a esperar dos
argumentos). Los demás mockean `pickAdapter` con firma variádica y no se
inmutan.

**Valor no reconocido:** si `WA_PROVIDER` trae algo que no es `"ycloud"` ni
`"meta"` (typo tipo `"yclod"`), se registra `console.error` y se cae a `"meta"`.
No se lanza — tumbar el turno por una var mal escrita es peor que responder por
el proveedor por defecto — pero tampoco se degrada en silencio.

### 4. `src/env.ts`

```ts
WA_PROVIDER?: "ycloud" | "meta";  // default "meta" — no cambia nada upstream
YCLOUD_API_KEY?: string;          // header X-API-Key
YCLOUD_WEBHOOK_SECRET?: string;   // whsec_… del endpoint, firma + media
YCLOUD_WA_FROM?: string;          // +524444237875 (el número, no un id)
```

`WA_PROVIDER` default `"meta"` para que el fork siga comportándose igual que el
upstream si alguien no configura nada.

### 5. Fix del Hallazgo 6 — learn-mode inalcanzable en producción

`startLearnMode()` y `stopLearnMode()` existen en `src/learn/mapping.ts:88` y
están testeados, pero **ningún código de producción los llama**: no hay ruta, ni
CLI, ni panel. Solo los tests. Como `/webhooks/learn/:channel` responde
`409 learn mode off` cuando está apagado, la feature completa es inalcanzable en
producción.

Es bloqueante para la Etapa A, así que se arregla aquí:

- `POST /admin/learn/:channel/start` (body opcional `{ minutes }`, default 15)
- `POST /admin/learn/:channel/stop`

Dentro del sub-app `adminApp`, que ya está protegido con Basic Auth
(`src/index.ts:197`). Llaman a las funciones existentes; no se reimplementa
nada.

**Nota de seguridad:** `/webhooks/learn/:channel` no valida firma — solo exige
learn-mode encendido, con expiración automática (`learn:<channel>:until`). Para
una ventana de captura acotada es aceptable, pero no debe quedar encendido.

## Manejo de errores

| Situación | Respuesta | Motivo |
|---|---|---|
| Firma inválida o ausente | `403` | Fail-closed, igual que Meta |
| Timestamp fuera de ventana | `403` | Anti-replay |
| JSON inválido | `400` | — |
| Evento que no es mensaje entrante | `200` | Nunca 500: YCloud reintenta |
| Fallo al enviar respuesta | log, sin throw | Ventana de 24h, no tumbar el turno |
| Media: firma mala / expirada / host no permitido | `403` / `410` / `403` | — |

## Pruebas

`test/channels/ycloud.test.ts`, espejo de la suite de whatsapp:

- Firma: válida, inválida, header malformado, timestamp expirado, sin secret.
- Parse: texto, imagen con caption, audio; evento de status ignorado (`null`);
  normalización del teléfono (`+52…` → `52…`).
- Media proxy: firma OK, firma mala, expirada, **host no permitido**.
- `sendReply`: varios chunks con delay, formato del body, error HTTP no lanza.

`test/index.test.ts` (o equivalente): despacho correcto según `WA_PROVIDER`, y
`GET /webhooks/whatsapp` → 404 con `ycloud`.

Rutas admin de learn-mode: start/stop, y que sin Basic Auth respondan 401.

**No-regresión:** los 446 tests actuales siguen en verde y `pnpm typecheck`
limpio.

## Ejecución

1. Implementar el fix de learn-mode (rutas admin) + `pnpm test` + deploy.
2. ~~Pausar LIA en n8n, encender learn-mode, mandar texto/imagen/audio de
   prueba, apagar learn-mode~~ — **no se ejecutó así.** En la práctica no hizo
   falta abrir la ventana de captura: el webhook de LIA venía recibiendo
   tráfico real desde hace meses y n8n conserva el historial de ejecuciones.
   Se leyó ese historial vía API REST de n8n (19 ejecuciones, todas de texto)
   y de ahí salió el único payload real disponible — ver
   `docs/superpowers/specs/ycloud-payloads-capturados.json`. LIA **nunca se
   pausó** porque nunca se le compitió por el endpoint. Imagen y audio no
   aparecían en el historial retenido, así que en ese momento quedaron sin
   verificar (se construyeron contra la documentación de YCloud, marcados
   como hipótesis en `ycloud.ts` y en sus tests). Se documentó esta vía como
   precedente para cuándo SÍ conviene usar learn-mode en
   `docs/canales/learn-mode.md`. **Actualización 2026-08-01:** sí se usó
   learn-mode para cerrar ese hueco — foto con caption + nota de voz reales,
   ver arriba.
3. Construir el parser de texto contra el payload real; imagen/audio contra
   la documentación (hipótesis, luego verificada contra tráfico real el
   2026-08-01 — ver punto 2).
4. Implementar el adapter completo + tests. Suite verde + typecheck limpio.
5. **Parar.** La Etapa B (corte) no se ejecuta hasta que la auditoría de LIA
   esté hecha desde el workspace "Consultor BIRevX AAIA".

## Criterios de aceptación

- [x] Learn-mode encendible y apagable desde una ruta autenticada.
      Verificado en `test/admin/learn-routes.test.ts` (start/stop con Basic
      Auth, 401 sin credenciales, CSRF/Content-Type, gate `LEARN_MODE_ENABLED`
      agregado en el commit `a6714d5` de esta rama).
- [x] Los 3 payloads reales de YCloud capturados y archivados.
      **Texto** confirmado contra tráfico real (19 ejecuciones del historial
      de n8n, commit `c807552`). **Imagen y audio** confirmados el
      2026-08-01: foto con caption + nota de voz (~11s) enviadas al número de
      producción, capturadas vía `POST /webhooks/learn/whatsapp`
      (`LEARN_MODE_ENABLED` temporal) y leídas de D1 (`learn:whatsapp:image`,
      `learn:whatsapp:audio`). Los 3 payloads están en
      `docs/superpowers/specs/ycloud-payloads-capturados.json`.
- [x] `ycloud.ts` parsea texto, imagen y audio de payloads reales.
      Texto: mismo respaldo que el punto anterior. Imagen y audio: verificado
      con los payloads reales del 2026-08-01 — la forma coincide con la
      hipótesis original de la documentación de YCloud. Cobertura en
      `test/channels/ycloud.test.ts` ("payload real capturado de producción"
      para imagen y audio); comentarios en `ycloud.ts` actualizados para
      reflejar que ya no es hipótesis.
- [x] Firma verificada fail-closed, con ventana anti-replay.
      `test/channels/ycloud.test.ts::describe("verifyYCloudSignature")`:
      firma vieja/futura fuera de ventana, header malformado, y fail-closed
      sin header o sin secret.
- [x] Proxy de media sirve audio e imagen sin exponer la API key, y rechaza
      hosts fuera de `api.ycloud.com`.
      `test/channels/ycloud.test.ts::describe("serveYCloudMedia")`: sirve
      bytes con X-API-Key sin exponerla al cliente, rechaza host fuera de
      `api.ycloud.com` y esquema distinto de https, sin llegar a golpear la
      red.
- [x] `channelUserId` normalizado a dígitos, idéntico al que produciría
      `whatsapp.ts`.
      `test/channels/shared.test.ts::"paridad de channelUserId entre
      adapters de WhatsApp"` — arreglado en el commit `90dd6a0` (antes,
      `whatsapp.ts` no normalizaba y el comentario de `ycloud.ts` que
      afirmaba lo contrario era falso; ver corrección de ese comentario en
      esta misma rama).
- [x] `WA_PROVIDER` conmuta proveedor **de entrada y de salida** sin cambios de
      código (`pickAdapter` incluido).
      `test/replies/sender.test.ts` (`pickAdapter`/envío) y
      `test/webhooks/whatsapp-dispatch.test.ts` (despacho del webhook
      entrante), commits `5f9c3ca` y `6be98bc`.
- [x] Suite completa en verde + typecheck limpio.
      `pnpm test` → 526 passed (69 archivos) · `pnpm typecheck` → limpio.
      Salida completa en
      `.superpowers/sdd/2026-08-01-ycloud-whatsapp-adapter/learn-gate-report.md`.
- [ ] LIA reactivada y endpoint de captura retirado.
      No aplica tal como estaba escrito: LIA **nunca se pausó** (ver
      "Ejecución" arriba — el payload se obtuvo del historial de n8n, no de
      una ventana de captura en vivo), así que no hubo nada que reactivar. El
      endpoint de captura tampoco se "retiró": sigue en el código pero ahora
      gateado por `LEARN_MODE_ENABLED` (apagado por defecto), ver
      `docs/canales/learn-mode.md`. Dejo sin marcar porque el criterio,
      literalmente, no ocurrió — quedó obsoleto por el cambio de método en la
      Task 2.

## Contribución upstream

Dos piezas son candidatas a PR a `santmun/forja`, sumadas a los 5 hallazgos ya
documentados:

- **Hallazgo 6:** learn-mode sin superficie de operador (bug — feature muerta).
- **Adapter YCloud:** canal nuevo. YCloud es BSP relevante en LATAM y el patrón
  `WA_PROVIDER` no rompe a nadie (default `meta`).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El payload real difiere de la doc | Por eso la Etapa A existe: se construye contra payloads reales |
| Wallet en 0.5 USD | Las conversaciones *service* (iniciadas por el cliente, ventana 24h) no se cobran; la prueba entra ahí. Vigilar si YCloud cobra fee de plataforma aparte |
| Doble respuesta al cliente | La Etapa A no responde nada; el 2º endpoint es solo de captura, y LIA queda pausada durante la ventana |
| Perder historial en el corte B→C | Channel id compartido + normalización de teléfono |
| Negocio no verificado (250 clientes/24h) | Suficiente para el piloto; no bloquea |
