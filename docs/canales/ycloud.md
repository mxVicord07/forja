# WhatsApp vía YCloud (BSP) — runbook del corte

Este documento es la referencia operativa para activar el canal de WhatsApp
usando [YCloud](https://www.ycloud.com/) como BSP (Business Solution Provider),
mientras la Verificación de Negocio ante Meta esté pendiente. El destino final
sigue siendo WhatsApp Cloud API directo de Meta (`src/channels/whatsapp.ts`);
YCloud es un puente temporal, no un canal paralelo — por eso ambos adapters
comparten `channel:"whatsapp"` y deben producir el mismo `channelUserId`
(ver `src/channels/shared.ts::normalizePhone`).

Las variables involucradas viven hoy solo en `src/env.ts` (que documenta el
tipo, no el procedimiento). Este archivo es el que alguien va a seguir el día
del corte a producción.

## Variables a configurar

### Secrets (`wrangler secret put <NOMBRE>`)

| Secret | Qué es |
|---|---|
| `YCLOUD_API_KEY` | Header `X-API-Key` para YCloud: se usa tanto para enviar mensajes salientes como para descargar el media entrante (imagen/audio) desde YCloud. |
| `YCLOUD_WEBHOOK_SECRET` | El `whsec_…` del endpoint del webhook, configurado en el panel de YCloud. Se usa para verificar la firma `YCloud-Signature` de cada POST entrante y para firmar las URLs del proxy de media saliente hacia el bot (`/webhooks/whatsapp/media`). |

```bash
wrangler secret put YCLOUD_API_KEY
wrangler secret put YCLOUD_WEBHOOK_SECRET
```

### Vars en `wrangler.toml`

| Var | Valor | Qué hace |
|---|---|---|
| `WA_PROVIDER` | `"ycloud"` | Conmuta el canal `/webhooks/whatsapp` (entrada y salida) a la implementación de YCloud. Default si se omite: `"meta"` — ver la sección de modo de falla abajo. |
| `YCLOUD_WA_FROM` | `"+524444237875"` | Número emisor en E.164 (con `+`), el que YCloud usa para mandar los mensajes salientes. |

```toml
[vars]
WA_PROVIDER = "ycloud"
YCLOUD_WA_FROM = "+524444237875"
```

## El orden del corte (importa, y es contraintuitivo)

1. **Setear los secrets y las vars** (`wrangler secret put` + editar
   `wrangler.toml`).
2. **`pnpm deploy`.** En este punto el Worker ya sabe hablar YCloud
   (`WA_PROVIDER=ycloud` activo), pero nadie le apunta todavía — el panel de
   YCloud sigue mandando (o no mandando nada) al endpoint viejo. Impacto cero
   en producción.
3. **Verificar `/health`** responde `200 ok` con el deploy nuevo arriba.
4. **Recién ahí**, entrar al panel de YCloud y apuntar el webhook a
   `https://<tu-worker>/webhooks/whatsapp`.

### Por qué el orden inverso es peligroso

Si se apunta el webhook de YCloud **antes** de que `WA_PROVIDER=ycloud` esté
desplegado, cada POST de YCloud le llega a un Worker que todavía cree que el
proveedor es `"meta"` (el default). Esa rama intenta verificar
`X-Hub-Signature-256` — un header que YCloud nunca manda, porque YCloud firma
con `YCloud-Signature` — y la verificación falla con `403 bad signature`.

El resultado es silencioso: **el bot queda sordo en WhatsApp sin un solo error
visible en el panel de YCloud** (YCloud ve el 403 como una respuesta válida al
webhook, no como una alarma) ni en el dashboard admin de Forja (no hay ninguna
métrica de "webhooks rechazados" hoy). Solo se nota cuando un cliente escribe
y nunca recibe respuesta.

## Rollback

Volver `WA_PROVIDER` a `"meta"` **no alcanza**. El webhook en el panel de
YCloud seguiría apuntando a `/webhooks/whatsapp` de Forja, y con
`WA_PROVIDER=meta` esa ruta vuelve a esperar la firma de Meta — mismo modo de
falla que arriba, pero en reversa (YCloud sigue mandando tráfico real y ahora
lo rechaza el bot).

Rollback completo:

1. Restaurar `WA_PROVIDER` a `"meta"` (o quitarlo, ya que `"meta"` es el
   default) y volver a desplegar.
2. **Restaurar también el endpoint anterior en el panel de YCloud** (o
   despausar/eliminar la suscripción del webhook), para que YCloud deje de
   mandarle tráfico a una ruta que ya no lo entiende.

## Advertencia sobre el panel admin (`Conexiones`)

`src/admin/views/conexiones.ts` (líneas ~44-48 y ~77-83) calcula el estado de
la card "WhatsApp (Oficial · Cloud API)" mirando **únicamente** las variables
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_VERIFY_TOKEN`/`META_VERIFY_TOKEN` y
`WHATSAPP_APP_SECRET`/`META_APP_SECRET`. No sabe nada de `YCLOUD_*` ni de
`WA_PROVIDER`.

Consecuencia: con YCloud funcionando perfectamente en producción (mensajes
entrando y saliendo sin problema), esa card del panel va a seguir mostrando
**"faltan variables" en rojo**, porque las variables que audita son las de
Meta, no las de YCloud. Es un falso negativo esperado — documentado acá para
que nadie, en medio del corte, interprete ese rojo como que algo salió mal y
empiece a debuggear un canal que sí funciona.

Esta vista **no se corrige** en este cambio — está fuera de alcance. Si en
algún momento se decide arreglarla, hay que sumarle sus propias variables
`YCLOUD_*` condicionadas a `WA_PROVIDER === "ycloud"`.

## Verificación pre-corte (go/no-go) sobre el formato de teléfono

Antes de mover `WA_PROVIDER` de `"ycloud"` a `"meta"` en el futuro (el corte
final, cuando la Verificación de Negocio ante Meta esté lista), hay que
validar que el `wa_id` real que manda Meta en producción coincide en formato
con los `channelUserId` que ya están guardados en D1 desde la etapa YCloud.

Procedimiento:

1. Capturar un payload real entrante de WhatsApp Cloud API de Meta (por
   ejemplo con el modo learn del webhook universal, o un log de request).
2. Extraer el campo `from` (o `contacts[].wa_id`) de ese payload.
3. Comparar contra los `channelUserId` ya existentes en D1 para el mismo
   número de teléfono real (mismo cliente, capturado bajo YCloud).

**El riesgo conocido:** el `wa_id` que entrega Meta históricamente incluye un
dígito extra en algunos países — México (`521…` en vez de `52…`) y Argentina
(`549…` en vez de `54…`) son los casos documentados. `normalizePhone` no
sabe nada de esto: solo deja dígitos, así que si Meta manda un dígito de más,
el `channelUserId` que produce **no** va a coincidir con el que ya vive en D1
para ese mismo cliente bajo YCloud.

Si en el paso 3 aparece esa diferencia, **la migración de YCloud a Meta
necesita un script de renombrado** — de las filas en D1 (conversaciones,
leads) y de los Durable Objects direccionados por `whatsapp:<channelUserId>`
— no alcanza con cambiar `WA_PROVIDER`. Correr ese script es un prerequisito
del corte final en los países donde aparezca la diferencia, no un nice-to-have
posterior.
