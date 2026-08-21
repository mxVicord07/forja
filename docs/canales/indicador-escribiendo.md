# Indicador de "escribiendo…" (los tres puntitos)

Mientras el bot prepara la respuesta, el cliente ve el indicador nativo de su
app — los mismos tres puntitos que aparecen cuando le escribe una persona. No
es una animación nuestra: es la del canal, disparada por API.

## Por qué importa

Entre que el cliente manda su mensaje y le llega la respuesta pasan el **buffer
de mensajes** (3-30 s, configurable) más el **turno del LLM** (segundos más, y
más todavía si hay audio que transcribir o herramientas que correr). Ese hueco
se siente como "nadie me está atendiendo". El indicador lo llena con la única
señal que el cliente ya sabe leer.

## Soporte por canal

| Canal | Cómo | Se apaga solo a los |
|---|---|---|
| Telegram | `sendChatAction` con `action: "typing"` | ~5 s |
| WhatsApp (Cloud API de Meta) | acuse de lectura + `typing_indicator` sobre el wamid entrante | 25 s |
| WhatsApp (YCloud) | `POST /v2/whatsapp/inboundMessages/{id}/typing` | 25 s |
| Messenger | sender action `typing_on` (precedida de `mark_seen`) | ~20 s |
| Instagram | igual que Messenger | ~20 s |
| ManyChat | ❌ no lo expone en su API de envío (solo en el Flow Builder) | — |
| Twilio | ❌ no lo expone para WhatsApp fuera de su beta | — |

En los dos canales sin soporte el bot se comporta exactamente igual que antes:
`supportsTyping()` devuelve `false` y no se hace ninguna llamada.

**Detalle de WhatsApp:** ahí el indicador NO es un endpoint aparte — viaja
dentro del acuse de lectura del mensaje entrante. Encenderlo implica que el
cliente vea también las palomitas azules. Es deliberado: "ya te leí, ahí voy"
es justamente el mensaje. Por lo mismo, requiere el **wamid** del mensaje
entrante; sin él el adapter se salta la llamada en silencio.

## Cómo funciona por dentro

1. **Al recibir** (`SupportAgent.ingest`) se enciende una vez, ya pasados todos
   los guards (dueño interviniendo, conversación pausada, spam, tope diario):
   los proveedores piden explícitamente mostrarlo **solo si vas a responder**.
   Va antes de transcribir el audio o anotar la imagen, que es justo el
   silencio que queremos tapar.
2. **Mientras el bot piensa** (`SupportAgent.processBuffer`) corre un
   *keepalive* que lo re-enciende (`src/replies/typing.ts`), porque todos los
   proveedores lo apagan solos antes de que la respuesta esté lista. Sigue vivo
   durante el envío: entre un chunk y el siguiente el cliente ve "escribiendo…"
   otra vez, como con una persona real.
3. **Se apaga** al llegar el mensaje (automático en todos los canales) o al
   tope duro de 90 s — si el turno se colgó, dejar puntitos eternos miente.

Todo el camino es *fail-open*: cualquier error del proveedor se registra como
`warn` y el turno sigue. El indicador nunca puede impedir que salga una
respuesta.

## Interruptor

Panel `/admin` → **Mi Agente** → nodo **Respuesta** → *Mostrar "escribiendo…"
mientras prepara la respuesta*. Se guarda en el setting `typing_indicator`
(`"0"` = apagado; ausente o cualquier otro valor = **encendido**, que es el
default). Como todo cambio de configuración, queda registrado en la Instrucción
Maestra Viva.

## Costo

Ninguno del lado de Meta/YCloud: no son mensajes facturables ni abren ventana
de conversación — viajan por el mismo endpoint que los acuses de lectura. Del
lado de Cloudflare son subrequests del Worker (1 al recibir + 1 por refresco).

## Referencias

- WhatsApp Cloud API — https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/
- YCloud — https://docs.ycloud.com/reference/whatsapp_inbound_message-typing
- Messenger sender actions — https://developers.facebook.com/docs/messenger-platform/send-messages/sender-actions
- Telegram `sendChatAction` — https://core.telegram.org/bots/api#sendchataction
