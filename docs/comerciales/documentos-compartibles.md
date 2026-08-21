# Documentos compartibles (F-docs)

El bot puede **mandar un archivo** (PDF, típicamente) además de responder en
texto — un catálogo de precios, un brochure, una tabla de paquetes. Distinto
del KB (`src/kb/docs.ts`): ahí el dueño escribe texto que el bot *cita*; acá
sube un archivo que el bot *envía tal cual*, adjunto nativo del canal.

## Por qué esta arquitectura y no una integración con OneDrive/SharePoint

La idea original era conectar directo una nube externa (OneDrive, SharePoint)
como fuente de los documentos. Se descartó por dos razones:

1. **El LLM no lee un archivo adjunto en el chat.** Conectar el enlace no
   resuelve nada por sí solo — alguien (o algo) tiene que decidir CUÁNDO
   compartir CUÁL archivo. Eso siempre pasa por una tool que el LLM invoca;
   de dónde viene el archivo es un detalle de implementación, no el problema
   real.
2. **Acoplarse a Graph API (OAuth delegado, tokens que expiran, permisos de
   Sites.Read.All) es mucho para el problema real**, que es: "el dueño sube
   un PDF una vez, el bot lo manda cuando aplica". R2 (ya provisionado en
   todo despliegue de Forja, bucket `CATALOG`, sin usar hasta ahora) resuelve
   exactamente eso sin secretos nuevos ni dependencias externas.

Si en el futuro el catálogo de documentos vive genuinamente en SharePoint (el
dueño ya los mantiene ahí y no quiere re-subirlos), se puede agregar un cron
que sincronice SharePoint → R2 sin tocar nada de lo de abajo — el bot nunca
necesita hablar con Graph API en el camino caliente de una conversación.

## Cómo funciona

```
Cliente pregunta "¿cuánto cuesta una página web?"
        │
        ▼
LLM decide llamar shareDocument({query: "precios sitios web"})
        │
        ▼
matchDocument() empareja contra título/descripción en D1 (tabla `documents`)
        │
        ▼
onShare(doc) — el agente GUARDA cuál documento hay que mandar (no lo manda aún)
        │
        ▼
El LLM sigue su turno normal y escribe la respuesta en texto
        │
        ▼
agent.ts manda el TEXTO primero (adapter.sendReply) — como siempre
        │
        ▼
Si hubo shareDocument este turno: firma una URL de /files/:id (30 min TTL)
y manda el archivo (adapter.sendDocument) — SEGUNDO mensaje, después del texto
```

El archivo llega como un mensaje aparte, después de la explicación — igual
que lo haría una persona: primero te dice qué es, luego te lo manda.

## Piezas

| Pieza | Archivo |
|---|---|
| Metadata en D1 (título, descripción, dónde vive en R2) | `src/db/documents.ts` |
| Match por palabras (igual de simple que `catalogQuery`) | `matchDocument()` en el mismo archivo |
| Tool que el LLM invoca | `src/tools/shareDocument.ts` |
| URL firmada de salida (HMAC + TTL, mismo patrón que el proxy de media entrante) | `src/files/share.ts` |
| Sirve el archivo desde R2 tras validar la firma | `src/files/serve.ts`, ruta `GET /files/:id` |
| Envío nativo por canal | `sendDocument()` en cada adapter |
| Subida desde el panel | `/admin/documentos` |

## Soporte por canal

| Canal | Cómo | Caption |
|---|---|---|
| Telegram | `sendDocument` con la URL directa (Telegram la descarga) | sí |
| WhatsApp (Cloud API y YCloud) | mensaje `type:"document"` con `link` | sí |
| Messenger / Instagram | adjunto `type:"file"` (Send API) | no — el texto ya salió antes por separado |
| ManyChat / Twilio | ❌ no implementado (igual que el indicador de "escribiendo…") | — |

## Seguridad

- La URL de `/files/:id` está firmada (HMAC-SHA256 + expiración de 30 min) —
  el mismo patrón que ya usan los proxies de media ENTRANTE de WhatsApp/YCloud,
  invertido: ahí protegen la descarga de lo que llegó, acá la publicación de
  lo que se comparte.
- El LLM nunca ve ni puede inventar una `r2_key`: `shareDocument` solo puede
  devolver documentos que el dueño subió y que existen en la tabla
  `documents`. No hay forma de que el bot mande un archivo arbitrario.
- Firma con `FILES_SIGNING_SECRET` si está configurado; si no, cae a
  `KB_REINDEX_TOKEN` (ya garantizado en todo despliegue existente) — mismo
  patrón de fallback que `WHATSAPP_APP_SECRET → META_APP_SECRET`.

## Disponibilidad

No es Pro-only: compartir un PDF es infraestructura básica de ventas, igual
que `captureLead`. No consume tokens de visión ni cuesta más que un mensaje
de texto normal.

## Cómo agregar un documento

`/admin` → **Documentos** → subir el PDF con un título y una descripción de
"cuándo compartirlo" (las palabras que el cliente diría para pedirlo — es lo
único que ve el matcher, no hace falta que sea el contenido real del PDF).
