# Adapter de WhatsApp vía YCloud — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar al bot `birevx-support-bot` un canal de WhatsApp operando sobre YCloud como BSP, conmutable a WhatsApp Cloud API directo por variable de entorno y sin perder historial de conversación.

**Architecture:** Un `ChannelAdapter` nuevo (`src/channels/ycloud.ts`) que emite el mismo `channel: "whatsapp"` que el adapter de Meta ya existente. `WA_PROVIDER` selecciona proveedor en runtime, tanto en la entrada (`src/index.ts`) como en la salida (`pickAdapter`). Antes de escribir el parser se capturan payloads reales con el endpoint `/webhooks/learn/whatsapp`, que hoy está muerto y hay que revivir.

**Tech Stack:** TypeScript · Cloudflare Workers · Hono · Vitest · Web Crypto (`crypto.subtle`) · D1

**Spec:** `docs/superpowers/specs/2026-08-01-ycloud-whatsapp-adapter-design.md`

**Rama:** `feat/ycloud-whatsapp-adapter`

## Global Constraints

- Todo el código y los comentarios en el estilo del repo: comentarios en español, explicando el *porqué* (no el qué). Igualar la densidad de comentarios de `src/channels/whatsapp.ts`.
- `WA_PROVIDER` default `"meta"`. Nunca `"ycloud"` — cambiarlo rompería en silencio a cualquier usuario upstream de `whatsapp.ts`.
- `channel` siempre `"whatsapp"`. **No** agregar `"ycloud"` al union `ChannelId` de `src/channels/shared.ts`.
- `channelUserId` siempre dígitos sin `+` ni separadores (formato canónico de `whatsapp.ts`).
- Firma: fail-closed. Sin secret configurado ⇒ rechazar, nunca aceptar.
- Un webhook nunca responde `500` a un evento bien formado que no sea mensaje: YCloud reintenta.
- No-regresión: los 446 tests actuales siguen verdes y `pnpm typecheck` limpio al final de **cada** tarea.
- Endpoint de envío: `POST https://api.ycloud.com/v2/whatsapp/messages`, header `X-API-Key`.
- Header de firma: `YCloud-Signature: t=<unix_segundos>,s=<hmac_hex>` sobre `` `${t}.${rawBody}` ``.
- Ventana anti-replay: 5 minutos (300 s).
- TTL de URL de media firmada: 10 minutos (igual que `whatsapp.ts`).
- Host permitido para el proxy de media: `api.ycloud.com` exactamente.
- Comandos: `pnpm test` (suite completa), `pnpm vitest run <archivo>` (uno solo), `pnpm typecheck`.

---

### Task 1: Revivir learn-mode (Hallazgo 6)

`startLearnMode()`/`stopLearnMode()` existen y están testeados en `src/learn/mapping.ts:88`, pero ningún código de producción los llama — no hay ruta, ni CLI, ni panel. `/webhooks/learn/:channel` responde `409 learn mode off` y no hay forma soportada de encenderlo. Sin esto la captura de la Task 2 es imposible.

**Files:**
- Modify: `src/admin/routes.ts` (agregar dos rutas; el import de `mapping` es nuevo)
- Test: `test/admin/learn-routes.test.ts` (crear)

**Interfaces:**
- Consumes: `startLearnMode(repo, channel, minutes?, now?)`, `stopLearnMode(repo, channel)`, `isLearnMode(repo, channel, now?)` de `src/learn/mapping.ts`; `SettingsRepo` de `src/db/settings.ts`; `Db` de `src/db/client.ts`.
- Produces: `POST /admin/learn/:channel/start` y `POST /admin/learn/:channel/stop`, ambas bajo el Basic Auth que ya cubre `/admin/*`.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/admin/learn-routes.test.ts`. Sigue el patrón exacto de `test/admin/inbox.test.ts`: D1 real vía `createTestMiniflare()`, y `adminApp.request(path, init, env)` — **el sub-app se invoca directo, así que las rutas van sin el prefijo `/admin`**. Usuario de Basic Auth siempre `admin` (`src/admin/auth.ts:14`).

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { SettingsRepo } from "../../src/db/settings";
import { isLearnMode } from "../../src/learn/mapping";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`, "utf-8").toString("base64")}`,
};
const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" };

let env: Env;
let repo: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, DASHBOARD_PASSWORD: PASSWORD } as unknown as Env;
  repo = new SettingsRepo(new Db(d1));
});

describe("rutas admin de learn-mode", () => {
  it("start enciende learn-mode para el canal", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    expect(res.status).toBe(200);
    expect(await isLearnMode(repo, "whatsapp")).toBe(true);
  });

  it("stop lo apaga", async () => {
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    await adminApp.request("/learn/whatsapp/stop", { method: "POST", headers: AUTH }, env);
    expect(await isLearnMode(repo, "whatsapp")).toBe(false);
  });

  it("respeta la duración en minutos del body", async () => {
    const res = await adminApp.request(
      "/learn/whatsapp/start",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ minutes: 1 }) },
      env,
    );
    expect((await res.json() as any).minutes).toBe(1);
  });

  it("usa 15 minutos por defecto cuando no viene body", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    expect((await res.json() as any).minutes).toBe(15);
  });

  it("no afecta a otros canales", async () => {
    await adminApp.request("/learn/whatsapp/start", { method: "POST", headers: AUTH }, env);
    expect(await isLearnMode(repo, "telegram")).toBe(false);
  });

  it("sin Basic Auth responde 401", async () => {
    const res = await adminApp.request("/learn/whatsapp/start", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm vitest run test/admin/learn-routes.test.ts`
Expected: FAIL — las rutas devuelven 404 (Hono no las conoce).

- [ ] **Step 3: Implementar las rutas**

En `src/admin/routes.ts`, agregar al bloque de imports:

```ts
import { startLearnMode, stopLearnMode } from "../learn/mapping";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
```

(Si `Db`/`SettingsRepo` ya están importados en ese archivo, no duplicar.)

Y las rutas, junto a las demás del sub-app:

```ts
// Learn-mode: enciende/apaga la captura de payloads crudos por canal. Las
// funciones existían desde el inicio pero NINGUNA ruta las llamaba, así que
// /webhooks/learn/:channel era inalcanzable en producción (siempre 409).
// Protegidas por el Basic Auth que ya cubre /admin/*: el endpoint de captura
// no valida firma, así que encenderlo debe requerir credenciales.
adminApp.post("/learn/:channel/start", async (c) => {
  const channel = c.req.param("channel");
  const body = await c.req.json<{ minutes?: number }>().catch(() => ({}));
  const minutes = Number(body.minutes) > 0 ? Number(body.minutes) : 15;
  const repo = new SettingsRepo(new Db(c.env.DB));
  await startLearnMode(repo, channel, minutes);
  return c.json({ ok: true, channel, minutes }, 200);
});

adminApp.post("/learn/:channel/stop", async (c) => {
  const channel = c.req.param("channel");
  const repo = new SettingsRepo(new Db(c.env.DB));
  await stopLearnMode(repo, channel);
  return c.json({ ok: true, channel }, 200);
});
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm vitest run test/admin/learn-routes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Suite completa + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 446 previos + 6 nuevos = 452 verdes, typecheck limpio.

- [ ] **Step 6: Commit**

```bash
git add src/admin/routes.ts test/admin/learn-routes.test.ts
git commit -m "Learn-mode encendible desde el panel

startLearnMode/stopLearnMode existían y estaban testeados, pero ninguna
ruta los llamaba: /webhooks/learn/:channel siempre respondía 409 y la
feature era inalcanzable en producción."
```

---

### Task 2: Capturar payloads reales de YCloud (operacional)

**No es una tarea de código.** Es la compuerta que hace que el parser de la Task 5 se escriba contra la realidad y no contra la documentación. La Task 5 **no puede empezar** hasta que esto termine.

Requiere acciones del usuario en dos paneles externos (n8n y YCloud) que el agente no puede hacer por sí solo. Si estás ejecutando este plan como subagente: **detente aquí y pide al usuario que ejecute los pasos**, luego continúa con los payloads que te entregue.

**Files:**
- Create: `docs/superpowers/specs/ycloud-payloads-capturados.json` (evidencia archivada)

**Interfaces:**
- Produces: los 3 payloads reales (texto, imagen, audio) que la Task 5 usa como fixtures de test.

- [ ] **Step 1: Desplegar lo de la Task 1**

Run: `pnpm deploy`
Expected: deploy OK. Verificar con `curl https://birevx-support-bot.victor-m-426.workers.dev/health` → `ok`.

- [ ] **Step 2: [USUARIO] Pausar LIA en n8n**

Desactivar el workflow `8E0Y7ap8iMBxWREA` ("WAB Asistente Operativo BIRevX - LIA"). Sin esto, los mensajes de prueba disparan respuestas de LIA — ruido inofensivo, pero evitable.

- [ ] **Step 3: Encender learn-mode**

```bash
curl -X POST -u admin:$DASHBOARD_PASSWORD \
  -H "Content-Type: application/json" -d '{"minutes":20}' \
  https://birevx-support-bot.victor-m-426.workers.dev/admin/learn/whatsapp/start
```

Expected: `{"ok":true,"channel":"whatsapp","minutes":20}`

- [ ] **Step 4: [USUARIO] Agregar el endpoint de captura en YCloud**

Panel YCloud → Developers → Webhooks → **Add Endpoints**:
- URL: `https://birevx-support-bot.victor-m-426.workers.dev/webhooks/learn/whatsapp`
- Evento: `whatsapp.inbound_message.received`
- Descripción: `[TEMPORAL] Captura Forja — borrar tras la sesión`

Dejar el endpoint de LIA existente como está (aunque su workflow esté pausado).

- [ ] **Step 5: [USUARIO] Enviar los 3 mensajes de prueba**

Desde un WhatsApp personal, al **+52 444 423 7875**, uno por uno:
1. Un texto: `prueba texto forja`
2. Una foto con caption: `prueba imagen forja`
3. Una nota de voz de ~3 segundos

- [ ] **Step 6: Apagar learn-mode**

```bash
curl -X POST -u admin:$DASHBOARD_PASSWORD \
  https://birevx-support-bot.victor-m-426.workers.dev/admin/learn/whatsapp/stop
```

- [ ] **Step 7: Extraer los payloads capturados de D1**

Se guardan como settings `learn:whatsapp:text|image|audio` (ver `src/learn/mapping.ts:21`).

```bash
wrangler d1 execute <DB_NAME> --remote --command \
  "SELECT key, value FROM settings WHERE key LIKE 'learn:whatsapp:%'"
```

Guardar los tres valores en `docs/superpowers/specs/ycloud-payloads-capturados.json`.

- [ ] **Step 8: Contrastar contra el spec**

Comparar las rutas reales contra la tabla de mapeo del spec (sección "Componentes → parseYCloudEvent"). Anotar cualquier diferencia — la tabla del spec es hipótesis derivada de la documentación, y **los payloads reales mandan**. Confirmar en particular:
- ¿`from` trae `+` o no? (decide cuánto trabaja el normalizador)
- ¿El envelope es `whatsappInboundMessage` o `whatsappMessage`? (la doc de YCloud usa ambos nombres en distintas páginas)
- ¿La imagen trae `caption` al mismo nivel que `link`?

Si algo difiere, corregir el spec **antes** de la Task 5.

- [ ] **Step 9: [USUARIO] Restaurar el estado operativo**

1. Borrar el endpoint `[TEMPORAL]` en YCloud.
2. Reactivar el workflow de LIA en n8n.
3. Verificar mandando un mensaje al número: LIA debe responder normal.

- [ ] **Step 10: Commit de la evidencia**

```bash
git add docs/superpowers/specs/ycloud-payloads-capturados.json
git commit -m "Payloads reales de YCloud capturados en sombra

Base factual del parser: se construye contra estos, no contra la doc."
```

---

### Task 3: Compartir los helpers de HMAC y declarar las env vars

Refactor sin cambio de comportamiento, más las variables nuevas. Se hace antes del adapter para que la Task 4 tenga de dónde importar.

**Files:**
- Modify: `src/channels/shared.ts` (agregar 2 funciones exportadas)
- Modify: `src/channels/whatsapp.ts:41-57` (borrar las locales, importar de `shared`)
- Modify: `src/env.ts` (4 vars nuevas)
- Test: `test/channels/shared.test.ts` (crear)

**Interfaces:**
- Produces:
  - `hmacHex(secret: string, message: string): Promise<string>`
  - `timingSafeEqual(a: string, b: string): boolean`
  - `Env.WA_PROVIDER?: "ycloud" | "meta"`, `Env.YCLOUD_API_KEY?: string`, `Env.YCLOUD_WEBHOOK_SECRET?: string`, `Env.YCLOUD_WA_FROM?: string`

- [ ] **Step 1: Escribir el test que falla**

Crear `test/channels/shared.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hmacHex, timingSafeEqual } from "../../src/channels/shared";

describe("hmacHex", () => {
  it("produce un HMAC-SHA256 hex estable", async () => {
    const a = await hmacHex("clave", "mensaje");
    const b = await hmacHex("clave", "mensaje");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cambia si cambia el secret", async () => {
    expect(await hmacHex("k1", "m")).not.toBe(await hmacHex("k2", "m"));
  });
});

describe("timingSafeEqual", () => {
  it("true solo si son idénticos", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("false si difieren en longitud", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `pnpm vitest run test/channels/shared.test.ts`
Expected: FAIL — `hmacHex is not a function` (no está exportada de `shared.ts`).

- [ ] **Step 3: Mover los helpers a `shared.ts`**

Agregar al final de `src/channels/shared.ts` (el cuerpo se copia tal cual de `whatsapp.ts:41-57`, no se reescribe):

```ts
/**
 * HMAC-SHA256 en hex. Compartido por los adapters que verifican firmas de
 * webhook y firman URLs de proxy de media (WhatsApp Cloud y YCloud).
 */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparación en tiempo constante: no filtra el contenido por timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 4: Quitar las copias locales de `whatsapp.ts`**

Borrar las definiciones `hmacHex` y `timingSafeEqual` de `src/channels/whatsapp.ts:41-57` y cambiar el import de la línea 16:

```ts
import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import { hmacHex, timingSafeEqual } from "./shared";
```

- [ ] **Step 5: Agregar las env vars**

En `src/env.ts`, junto al bloque de WhatsApp (línea ~59):

```ts
  // Proveedor del canal WhatsApp. "meta" = Cloud API directo (WHATSAPP_*),
  // "ycloud" = YCloud como BSP (YCLOUD_*). Default "meta": cambiarlo rompería
  // en silencio a quien ya opera con Cloud API directo — la firma de YCloud
  // rechazaría todos los payloads de Meta con 403 y el bot dejaría de
  // responder sin un error visible.
  WA_PROVIDER?: "ycloud" | "meta";
  YCLOUD_API_KEY?: string;         // header X-API-Key (envío y descarga de media)
  YCLOUD_WEBHOOK_SECRET?: string;  // whsec_… del endpoint: firma entrante + URLs de media
  YCLOUD_WA_FROM?: string;         // número emisor en E.164, p.ej. +524444237875
```

- [ ] **Step 6: Correr todo**

Run: `pnpm vitest run test/channels/shared.test.ts test/channels/whatsapp.test.ts && pnpm test && pnpm typecheck`
Expected: los nuevos pasan y **los de whatsapp siguen igual de verdes** — es la prueba de que el refactor no cambió comportamiento.

- [ ] **Step 7: Commit**

```bash
git add src/channels/shared.ts src/channels/whatsapp.ts src/env.ts test/channels/shared.test.ts
git commit -m "Compartir los helpers de HMAC entre adapters de canal

hmacHex y timingSafeEqual eran privados de whatsapp.ts; el adapter de
YCloud los necesita igual. Se agregan también las env vars de YCloud y
WA_PROVIDER (default meta, para no alterar el comportamiento actual)."
```

---

### Task 4: Verificación de firma de YCloud

**Files:**
- Create: `src/channels/ycloud.ts`
- Test: `test/channels/ycloud.test.ts` (crear)

**Interfaces:**
- Consumes: `hmacHex`, `timingSafeEqual` de `src/channels/shared.ts` (Task 3).
- Produces: `verifyYCloudSignature(raw: string, header: string | null | undefined, secret: string, now?: number): Promise<boolean>`. El parámetro `now` es inyectable para que los tests manejen la expiración sin tocar el reloj — mismo patrón que `isLearnMode` en `src/learn/mapping.ts:76`.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/channels/ycloud.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { verifyYCloudSignature } from "../../src/channels/ycloud";
import { hmacHex } from "../../src/channels/shared";

const SECRET = "whsec_test";

async function signed(raw: string, tSeconds: number): Promise<string> {
  const s = await hmacHex(SECRET, `${tSeconds}.${raw}`);
  return `t=${tSeconds},s=${s}`;
}

describe("verifyYCloudSignature", () => {
  const raw = JSON.stringify({ hello: "world" });
  const now = 1_800_000_000_000; // ms
  const t = Math.floor(now / 1000);

  it("acepta una firma válida y fresca", async () => {
    expect(await verifyYCloudSignature(raw, await signed(raw, t), SECRET, now)).toBe(true);
  });

  it("rechaza si el cuerpo fue alterado", async () => {
    const header = await signed(raw, t);
    expect(await verifyYCloudSignature(raw + "x", header, SECRET, now)).toBe(false);
  });

  it("rechaza una firma vieja (fuera de la ventana anti-replay)", async () => {
    const old = t - 301; // 5 min + 1 s
    expect(await verifyYCloudSignature(raw, await signed(raw, old), SECRET, now)).toBe(false);
  });

  it("rechaza un timestamp del futuro fuera de ventana", async () => {
    const future = t + 301;
    expect(await verifyYCloudSignature(raw, await signed(raw, future), SECRET, now)).toBe(false);
  });

  it("rechaza un header malformado", async () => {
    for (const h of ["", "basura", "t=abc,s=def", `t=${t}`, `s=abc`]) {
      expect(await verifyYCloudSignature(raw, h, SECRET, now)).toBe(false);
    }
  });

  it("rechaza si falta el header o el secret (fail-closed)", async () => {
    expect(await verifyYCloudSignature(raw, null, SECRET, now)).toBe(false);
    expect(await verifyYCloudSignature(raw, await signed(raw, t), "", now)).toBe(false);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: FAIL — no existe `src/channels/ycloud.ts`.

- [ ] **Step 3: Implementar**

Crear `src/channels/ycloud.ts`:

```ts
// Canal de WhatsApp vía YCloud (BSP). Alternativa a whatsapp.ts (Cloud API
// directo de Meta) mientras la Verificación de Negocio ante Meta esté
// pendiente. Ambos emiten channel:"whatsapp" a propósito — el Durable Object
// se direcciona con `${channel}:${channelUserId}`, así que compartir el id es
// lo que preserva el historial el día que se migre de un proveedor al otro.
//
// Diferencias contra Meta que este archivo tiene que absorber:
//  • Firma: header propio `YCloud-Signature: t=<unix>,s=<hmac>` sobre
//    `${t}.${body}`, y CON timestamp — así que además se valida antigüedad.
//    No hay handshake GET.
//  • Entrante: un evento = un mensaje (Meta batchea varios por POST).
//  • Media: viene como URL directa, no como media_id, pero su descarga exige
//    X-API-Key — o sea que igual necesita proxy firmado.
//  • Teléfono: E.164 con "+". Se normaliza a dígitos pelones, que es el
//    formato que ya produce whatsapp.ts.
import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import { hmacHex, timingSafeEqual } from "./shared";
import type { Env } from "../env";

/** Ventana anti-replay de la firma entrante. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verifica el header `YCloud-Signature: t=<unix_segundos>,s=<hmac_hex>`, donde
 * el HMAC-SHA256 se calcula sobre `${t}.${raw}`.
 *
 * A diferencia de Meta, la firma incluye timestamp: se valida que esté dentro
 * de la ventana en AMBAS direcciones (un reloj adelantado no debe abrir la
 * puerta). Fail-closed ante cualquier duda. `now` es inyectable para tests.
 */
export async function verifyYCloudSignature(
  raw: string,
  header: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!header || !secret) return false;

  let t: string | undefined;
  let s: string | undefined;
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") t = v?.trim();
    else if (k?.trim() === "s") s = v?.trim();
  }
  if (!t || !s) return false;

  const tSeconds = Number(t);
  if (!Number.isFinite(tSeconds)) return false;
  if (Math.abs(now - tSeconds * 1000) > SIGNATURE_TOLERANCE_MS) return false;

  const expected = await hmacHex(secret, `${t}.${raw}`);
  return timingSafeEqual(expected, s);
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Suite + typecheck**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/channels/ycloud.ts test/channels/ycloud.test.ts
git commit -m "YCloud: verificación de firma con ventana anti-replay

La firma de YCloud lleva timestamp (a diferencia de la de Meta), así que
se valida antigüedad en ambas direcciones además del HMAC."
```

---

### Task 5: Parsear el mensaje entrante

> **Bloqueada por la Task 2.** Antes de empezar, abrir `docs/superpowers/specs/ycloud-payloads-capturados.json` y usar esos payloads como fixtures. Si difieren de los de abajo, **mandan los capturados** — ajustar tests e implementación, y corregir la tabla del spec.

**Files:**
- Modify: `src/channels/ycloud.ts`
- Modify: `test/channels/ycloud.test.ts`

**Interfaces:**
- Consumes: `verifyYCloudSignature` (Task 4); `IncomingMessage` de `shared.ts`.
- Produces:
  - `normalizePhone(raw: string): string` — quita todo lo que no sea dígito.
  - `parseYCloudEvent(body: unknown, env: Env, origin: string): Promise<IncomingMessage | null>` — `null` cuando el evento no es un mensaje procesable.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/channels/ycloud.test.ts`:

```ts
import { parseYCloudEvent, normalizePhone } from "../../src/channels/ycloud";

const ORIGIN = "https://bot.example.workers.dev";
const env = { YCLOUD_WEBHOOK_SECRET: "whsec_test", YCLOUD_API_KEY: "key" } as any;

function evt(msg: any, type = "whatsapp.inbound_message.received") {
  return { id: "ev_1", type, apiVersion: "v2", createTime: "2026-08-01T00:00:00Z", whatsappInboundMessage: msg };
}

describe("normalizePhone", () => {
  it("deja solo dígitos", () => {
    expect(normalizePhone("+52 444 423 7875")).toBe("524444237875");
    expect(normalizePhone("524444237875")).toBe("524444237875");
  });
});

describe("parseYCloudEvent", () => {
  it("parsea texto y normaliza el teléfono", async () => {
    const out = await parseYCloudEvent(
      evt({ from: "+525512345678", customerProfile: { name: "María" }, type: "text", text: { body: "hola" } }),
      env, ORIGIN,
    );
    expect(out).not.toBeNull();
    expect(out!.channel).toBe("whatsapp"); // NO "ycloud"
    expect(out!.channelUserId).toBe("525512345678"); // sin "+"
    expect(out!.text).toBe("hola");
    expect(out!.displayName).toBe("María");
  });

  it("parsea imagen con caption y firma la URL de media", async () => {
    const out = await parseYCloudEvent(
      evt({
        from: "+525512345678", type: "image",
        image: { link: "https://api.ycloud.com/v2/whatsapp/media/download/abc", caption: "ese corte" },
      }),
      env, ORIGIN,
    );
    expect(out!.text).toBe("ese corte");
    expect(out!.imageUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media?`);
    expect(out!.imageUrl).toMatch(/[?&]sig=/);
    expect(out!.imageUrl).toMatch(/[?&]exp=/);
  });

  it("parsea nota de voz", async () => {
    const out = await parseYCloudEvent(
      evt({ from: "+525512345678", type: "audio",
            audio: { link: "https://api.ycloud.com/v2/whatsapp/media/download/xyz" } }),
      env, ORIGIN,
    );
    expect(out!.audioUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media?`);
    expect(out!.text).toBeUndefined();
  });

  it("ignora eventos que no son mensajes entrantes", async () => {
    const out = await parseYCloudEvent(
      evt({ from: "+525512345678", status: "delivered" }, "whatsapp.message.updated"),
      env, ORIGIN,
    );
    expect(out).toBeNull();
  });

  it("ignora un mensaje sin contenido utilizable", async () => {
    const out = await parseYCloudEvent(
      evt({ from: "+525512345678", type: "location", location: { latitude: 1, longitude: 2 } }),
      env, ORIGIN,
    );
    expect(out).toBeNull();
  });

  it("ignora un evento sin remitente", async () => {
    expect(await parseYCloudEvent(evt({ type: "text", text: { body: "x" } }), env, ORIGIN)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: FAIL — `parseYCloudEvent is not a function`.

- [ ] **Step 3: Implementar**

Agregar a `src/channels/ycloud.ts`:

```ts
const MEDIA_TTL_MS = 10 * 60 * 1000;
const INBOUND_EVENT = "whatsapp.inbound_message.received";

interface YCloudInboundMessage {
  from?: string;
  id?: string;
  type?: string;
  customerProfile?: { name?: string };
  text?: { body?: string };
  image?: { link?: string; caption?: string; id?: string };
  audio?: { link?: string; id?: string };
}

interface YCloudEvent {
  id?: string;
  type?: string;
  whatsappInboundMessage?: YCloudInboundMessage;
}

/**
 * Formato canónico interno del teléfono: solo dígitos. YCloud entrega E.164
 * con "+" y Meta Cloud API sin él; si no unificáramos, el Durable Object
 * `whatsapp:<id>` sería distinto en cada proveedor y el corte de YCloud a
 * Cloud API directo haría que cada cliente perdiera su historial.
 */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** URL firmada del proxy de media (o null si falta secret/base). */
async function signedMediaUrl(link: string, env: Env, origin: string): Promise<string | null> {
  const secret = env.YCLOUD_WEBHOOK_SECRET;
  const base = (origin || env.DASHBOARD_BASE_URL || "").replace(/\/$/, "");
  if (!secret || !base) return null;
  const exp = Date.now() + MEDIA_TTL_MS;
  const sig = await hmacHex(secret, `${link}.${exp}`);
  return `${base}/webhooks/whatsapp/media?u=${encodeURIComponent(link)}&exp=${exp}&sig=${sig}`;
}

/**
 * Convierte un evento de YCloud en un IncomingMessage, o null si no hay nada
 * que procesar (recibos de entrega, tipos no soportados, evento sin remitente).
 * Devuelve null en vez de lanzar: al mismo endpoint llegan eventos de estado
 * perfectamente normales, y lanzar obligaría a envolver cada llamada en
 * try/catch para no contestarle 500 a YCloud (que reintentaría).
 */
export async function parseYCloudEvent(
  body: unknown,
  env: Env,
  origin: string,
): Promise<IncomingMessage | null> {
  const event = body as YCloudEvent;
  if (event?.type !== INBOUND_EVENT) return null;

  const m = event.whatsappInboundMessage;
  const from = m?.from;
  if (!m || !from) return null;

  let text: string | undefined;
  let audioUrl: string | undefined;
  let imageUrl: string | undefined;

  if (m.type === "text") {
    text = m.text?.body || undefined;
  } else if (m.type === "image" && m.image?.link) {
    imageUrl = (await signedMediaUrl(m.image.link, env, origin)) ?? undefined;
    text = m.image.caption || undefined;
  } else if (m.type === "audio" && m.audio?.link) {
    audioUrl = (await signedMediaUrl(m.audio.link, env, origin)) ?? undefined;
  }

  console.log(
    "ycloud in:",
    JSON.stringify({ type: m.type, hasText: !!text, hasAudio: !!audioUrl, hasImage: !!imageUrl }),
  );
  if (!text && !audioUrl && !imageUrl) return null;

  return {
    channel: "whatsapp",
    channelUserId: normalizePhone(from),
    displayName: m.customerProfile?.name,
    text,
    audioUrl,
    imageUrl,
    isOwnerMessage: false,
    receivedAt: Date.now(),
    rawPayload: event,
  };
}
```

Nota de privacidad: el log no incluye el teléfono, siguiendo el commit `1934d25` ("fuera la PII de los logs").

- [ ] **Step 4: Correr y verificar que pasa**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: PASS (6 de la Task 4 + 7 nuevos = 13).

- [ ] **Step 5: Suite + typecheck**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/channels/ycloud.ts test/channels/ycloud.test.ts
git commit -m "YCloud: parseo de mensajes entrantes

Texto, imagen y audio. El teléfono se normaliza a dígitos para que el
Durable Object sea el mismo que produciría el adapter de Meta y el
historial sobreviva a la migración de proveedor."
```

---

### Task 6: Proxy firmado de media

`transcribe`/`vision` reciben una URL y la descargan sin credenciales. La URL de YCloud exige `X-API-Key`, así que hace falta el mismo proxy que ya usa Meta.

**Files:**
- Modify: `src/channels/ycloud.ts`
- Modify: `test/channels/ycloud.test.ts`

**Interfaces:**
- Consumes: `hmacHex`, `timingSafeEqual`; `signedMediaUrl` (privada, Task 5).
- Produces: `serveYCloudMedia(u: string | null, exp: string | null, sig: string | null, env: Env): Promise<Response>`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/channels/ycloud.test.ts`:

```ts
import { serveYCloudMedia } from "../../src/channels/ycloud";
import { vi, afterEach } from "vitest";

afterEach(() => vi.restoreAllMocks());

async function signMedia(link: string, exp: number) {
  return hmacHex("whsec_test", `${link}.${exp}`);
}

describe("serveYCloudMedia", () => {
  const link = "https://api.ycloud.com/v2/whatsapp/media/download/abc";

  it("sirve los bytes con firma válida y manda la API key", async () => {
    const exp = Date.now() + 60_000;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("BYTES", { status: 200, headers: { "Content-Type": "audio/ogg" } }),
    );
    const res = await serveYCloudMedia(link, String(exp), await signMedia(link, exp), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BYTES");
    const headers = (fetchMock.mock.calls[0][1] as any).headers;
    expect(headers["X-API-Key"]).toBe("key");
  });

  it("rechaza firma inválida con 403", async () => {
    const exp = Date.now() + 60_000;
    const res = await serveYCloudMedia(link, String(exp), "firmamala", env);
    expect(res.status).toBe(403);
  });

  it("rechaza una URL expirada con 410", async () => {
    const exp = Date.now() - 1000;
    const res = await serveYCloudMedia(link, String(exp), await signMedia(link, exp), env);
    expect(res.status).toBe(410);
  });

  it("rechaza un host fuera de api.ycloud.com aunque la firma sea válida", async () => {
    const evil = "https://evil.example.com/robar";
    const exp = Date.now() + 60_000;
    const res = await serveYCloudMedia(evil, String(exp), await signMedia(evil, exp), env);
    expect(res.status).toBe(403);
  });

  it("404 si no está configurado", async () => {
    const exp = Date.now() + 60_000;
    const res = await serveYCloudMedia(link, String(exp), await signMedia(link, exp), {} as any);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: FAIL — `serveYCloudMedia is not a function`.

- [ ] **Step 3: Implementar**

Agregar a `src/channels/ycloud.ts`:

```ts
/** Único host del que el proxy acepta descargar. */
const YCLOUD_MEDIA_HOST = "api.ycloud.com";

/**
 * Sirve el media entrante de YCloud: valida firma + expiración + host, y
 * descarga con la API key del lado del server. Público pero firmado — la key
 * nunca sale. Lo usa GET /webhooks/whatsapp/media (ver index.ts).
 *
 * A diferencia del proxy de Meta, aquí se firma una URL y no un media_id
 * opaco. Por eso se valida además que el host sea api.ycloud.com: sin ese
 * chequeo, quien obtuviera el secret podría convertir el Worker en un SSRF
 * que descarga cualquier URL de internet.
 */
export async function serveYCloudMedia(
  u: string | null,
  exp: string | null,
  sig: string | null,
  env: Env,
): Promise<Response> {
  const secret = env.YCLOUD_WEBHOOK_SECRET;
  const apiKey = env.YCLOUD_API_KEY;
  if (!secret || !apiKey) return new Response("not configured", { status: 404 });

  const expNum = Number(exp);
  if (!u || !exp || !sig || !Number.isFinite(expNum)) {
    return new Response("bad request", { status: 400 });
  }
  if (Date.now() > expNum) return new Response("expired", { status: 410 });

  const expected = await hmacHex(secret, `${u}.${exp}`);
  if (!timingSafeEqual(expected, sig)) return new Response("bad signature", { status: 403 });

  let host: string;
  try {
    host = new URL(u).hostname;
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (host !== YCLOUD_MEDIA_HOST) return new Response("host not allowed", { status: 403 });

  const res = await fetch(u, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) return new Response("media download failed", { status: 502 });
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return new Response(res.body, { status: 200, headers: { "Content-Type": contentType } });
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: PASS (18 en total).

- [ ] **Step 5: Suite + typecheck**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/channels/ycloud.ts test/channels/ycloud.test.ts
git commit -m "YCloud: proxy firmado de media con allowlist de host

La descarga exige X-API-Key, así que transcribe/vision no pueden bajarla
directo. Como aquí se firma una URL y no un id opaco, se restringe el
host a api.ycloud.com para no dejar un SSRF abierto."
```

---

### Task 7: Envío de respuestas

**Files:**
- Modify: `src/channels/ycloud.ts`
- Modify: `test/channels/ycloud.test.ts`

**Interfaces:**
- Consumes: `parseYCloudEvent` (Task 5).
- Produces: `ycloudAdapter: ChannelAdapter` — export nombrado, con `parseIncoming` y `sendReply`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/channels/ycloud.test.ts`:

```ts
import { ycloudAdapter } from "../../src/channels/ycloud";

describe("ycloudAdapter.sendReply", () => {
  const sendEnv = { YCLOUD_API_KEY: "key", YCLOUD_WA_FROM: "+524444237875" } as any;

  it("manda cada chunk con X-API-Key y el + de vuelta en el destinatario", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await ycloudAdapter.sendReply(
      { channel: "whatsapp", channelUserId: "525512345678", chunks: ["uno", "dos"], interChunkDelayMs: 0 },
      sendEnv,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.ycloud.com/v2/whatsapp/messages");
    expect(init.headers["X-API-Key"]).toBe("key");
    expect(JSON.parse(init.body)).toEqual({
      from: "+524444237875",
      to: "+525512345678",
      type: "text",
      text: { body: "uno", preview_url: false },
    });
  });

  it("no lanza si YCloud responde error (fuera de la ventana de 24h)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(
      ycloudAdapter.sendReply(
        { channel: "whatsapp", channelUserId: "525512345678", chunks: ["x"], interChunkDelayMs: 0 },
        sendEnv,
      ),
    ).resolves.toBeUndefined();
  });

  it("lanza si falta configuración", async () => {
    await expect(
      ycloudAdapter.sendReply(
        { channel: "whatsapp", channelUserId: "5", chunks: ["x"] },
        {} as any,
      ),
    ).rejects.toThrow(/YCLOUD/);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: FAIL — `ycloudAdapter` no está exportado.

- [ ] **Step 3: Implementar**

Agregar al final de `src/channels/ycloud.ts`:

```ts
const SEND_URL = "https://api.ycloud.com/v2/whatsapp/messages";

export const ycloudAdapter: ChannelAdapter = {
  // Existe por la interfaz ChannelAdapter; el webhook usa parseYCloudEvent
  // directamente, porque puede devolver null (eventos de estado) y la
  // interfaz obliga a devolver un IncomingMessage.
  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage> {
    const body = await request.json();
    const origin = new URL(request.url).origin;
    const msg = await parseYCloudEvent(body, env, origin);
    if (!msg) throw new Error("evento de YCloud sin mensaje procesable");
    return msg;
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const apiKey = env.YCLOUD_API_KEY;
    const from = env.YCLOUD_WA_FROM;
    if (!apiKey || !from) {
      throw new Error("YCloud: falta YCLOUD_API_KEY o YCLOUD_WA_FROM.");
    }
    // Internamente el teléfono viaja sin "+", pero YCloud exige E.164.
    const to = `+${reply.channelUserId.replace(/\D/g, "")}`;
    for (let i = 0; i < reply.chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await fetch(SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({
          from,
          to,
          type: "text",
          text: { body: reply.chunks[i], preview_url: false },
        }),
      });
      // Fuera de la ventana de 24h Meta rechaza texto libre (pide plantilla
      // HSM). No lo tragues en silencio, pero tampoco tumbes el turno.
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`ycloud sendReply ${res.status}: ${errBody}`);
      }
    }
  },
};
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `pnpm vitest run test/channels/ycloud.test.ts`
Expected: PASS (21 en total).

- [ ] **Step 5: Suite + typecheck**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/channels/ycloud.ts test/channels/ycloud.test.ts
git commit -m "YCloud: envío de respuestas

Cierra el ChannelAdapter. El teléfono recupera el + al salir, porque
internamente viaja como dígitos pelones."
```

---

### Task 8: `pickAdapter` conmuta por `WA_PROVIDER`

Sin esto el bot recibiría por YCloud e intentaría responder por Meta: entra el mensaje y nunca sale la respuesta.

**Files:**
- Modify: `src/replies/sender.ts:38`
- Modify: `src/agent.ts:106`, `src/agent.ts:426`, `src/campaigns.ts:144`, `src/followup/run.ts:177`, `src/admin/routes.ts:563`
- Modify: `test/replies/sender.test.ts:72-83`, `test/admin/inbox.test.ts:123`

**Interfaces:**
- Consumes: `ycloudAdapter` (Task 7); `Env.WA_PROVIDER` (Task 3).
- Produces: `pickAdapter(channel: ChannelId, env: Env): ChannelAdapter` — **cambio de firma**, todos los llamadores pasan `env`.

- [ ] **Step 1: Escribir los tests que fallan**

Reemplazar el `describe("pickAdapter")` de `test/replies/sender.test.ts:72-83`:

```ts
describe("pickAdapter", () => {
  const env = {} as any;

  it("maps each channel to an adapter exposing sendReply", () => {
    for (const ch of ["telegram", "manychat", "twilio"] as const) {
      const adapter = pickAdapter(ch, env);
      expect(typeof adapter.sendReply).toBe("function");
      expect(typeof adapter.parseIncoming).toBe("function");
    }
  });

  it("throws on an unknown channel", () => {
    expect(() => pickAdapter("sms" as any, env)).toThrow(/unknown channel/);
  });

  it("whatsapp usa el adapter de Meta por defecto", async () => {
    const { whatsappAdapter } = await import("../../src/channels/whatsapp");
    expect(pickAdapter("whatsapp", {} as any)).toBe(whatsappAdapter);
    expect(pickAdapter("whatsapp", { WA_PROVIDER: "meta" } as any)).toBe(whatsappAdapter);
  });

  it("whatsapp usa YCloud cuando WA_PROVIDER=ycloud", async () => {
    const { ycloudAdapter } = await import("../../src/channels/ycloud");
    expect(pickAdapter("whatsapp", { WA_PROVIDER: "ycloud" } as any)).toBe(ycloudAdapter);
  });

  it("un WA_PROVIDER no reconocido cae a Meta pero deja rastro en el log", async () => {
    const { whatsappAdapter } = await import("../../src/channels/whatsapp");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(pickAdapter("whatsapp", { WA_PROVIDER: "yclod" } as any)).toBe(whatsappAdapter);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

Asegurarse de que `vi` esté importado de `vitest` en ese archivo.

En `test/admin/inbox.test.ts:123`, la aserción pasa a aceptar el segundo argumento:

```ts
expect(pickAdapterMock).toHaveBeenCalledWith("telegram", expect.anything());
```

Y el mock de la línea 9 acepta dos parámetros:

```ts
const pickAdapterMock = vi.fn((_channel: unknown, _env?: unknown) => ({ sendReply: sendReplyMock }));
```

con el wrapper de la línea 12:

```ts
pickAdapter: (channel: unknown, env: unknown) => pickAdapterMock(channel, env),
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `pnpm vitest run test/replies/sender.test.ts test/admin/inbox.test.ts`
Expected: FAIL — typecheck/runtime se queja de argumentos y `pickAdapter("whatsapp", …)` devuelve siempre `whatsappAdapter`.

- [ ] **Step 3: Cambiar `pickAdapter`**

En `src/replies/sender.ts`, agregar el import y reemplazar la función:

```ts
import { ycloudAdapter } from "../channels/ycloud";
```

```ts
/**
 * Resuelve el adapter de SALIDA. Recibe `env` porque el canal "whatsapp" tiene
 * dos proveedores posibles (Cloud API directo de Meta y YCloud como BSP) que
 * comparten channel id a propósito — ver src/channels/ycloud.ts. Sin `env`,
 * la entrada podría venir por YCloud y la salida irse por Meta: el bot
 * recibiría el mensaje y nunca contestaría.
 */
export function pickAdapter(channel: ChannelId, env: Env): ChannelAdapter {
  if (channel === "telegram") return telegramAdapter;
  if (channel === "manychat") return manychatAdapter;
  if (channel === "twilio") return twilioAdapter;
  if (channel === "whatsapp") return pickWhatsAppAdapter(env);
  if (channel === "messenger" || channel === "instagram") return metaAdapter;
  throw new Error(`unknown channel: ${channel}`);
}

/**
 * Default "meta": no altera a quien ya opera con Cloud API directo. Un valor
 * no reconocido (typo) cae a Meta igual, pero lo registra — degradarse en
 * silencio por una variable mal escrita es peor que ser ruidoso, y lanzar
 * tumbaría el turno completo.
 */
function pickWhatsAppAdapter(env: Env): ChannelAdapter {
  const provider = env.WA_PROVIDER ?? "meta";
  if (provider === "ycloud") return ycloudAdapter;
  if (provider !== "meta") {
    console.error(`WA_PROVIDER no reconocido: ${provider} — usando "meta".`);
  }
  return whatsappAdapter;
}
```

- [ ] **Step 4: Actualizar los 5 llamadores**

Cada uno ya tiene `env` en el scope inmediato — es mecánico:

| Archivo:línea | Cambio |
|---|---|
| `src/agent.ts:106` | `pickAdapter(channel, this.env)` |
| `src/agent.ts:426` | `pickAdapter(channel, this.env)` |
| `src/campaigns.ts:144` | `pickAdapter(channel, env)` |
| `src/followup/run.ts:177` | `pickAdapter(cand.channel as ChannelId, env)` |
| `src/admin/routes.ts:563` | `pickAdapter(conv.channel as ChannelId, c.env)` |

Verificar que no quedó ninguno: `grep -rn "pickAdapter(" src/ | grep -v ", env)" | grep -v ", this.env)" | grep -v ", c.env)" | grep -v "export function"` no debe devolver nada.

- [ ] **Step 5: Correr y verificar que pasa**

Run: `pnpm vitest run test/replies/sender.test.ts test/admin/inbox.test.ts`
Expected: PASS.

- [ ] **Step 6: Suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: todo verde. El typecheck es el que garantiza que no quedó ningún llamador viejo.

- [ ] **Step 7: Commit**

```bash
git add src/replies/sender.ts src/agent.ts src/campaigns.ts src/followup/run.ts src/admin/routes.ts test/replies/sender.test.ts test/admin/inbox.test.ts
git commit -m "pickAdapter conmuta el proveedor de WhatsApp por WA_PROVIDER

Meta y YCloud comparten channel id a propósito (para no perder el
Durable Object en la migración), así que el channel id ya no alcanza
para elegir el adapter de salida: hace falta env."
```

---

### Task 9: Despacho por proveedor en el webhook

**Files:**
- Modify: `src/index.ts:133-169`
- Test: `test/webhooks/whatsapp-dispatch.test.ts` (crear)

**Interfaces:**
- Consumes: `verifyYCloudSignature`, `parseYCloudEvent`, `serveYCloudMedia` (Tasks 4-6).
- Produces: `POST /webhooks/whatsapp` sensible a `WA_PROVIDER`; `GET /webhooks/whatsapp/media` (YCloud, query params) coexistiendo con `GET /webhooks/whatsapp/media/:id` (Meta, path param).

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/webhooks/whatsapp-dispatch.test.ts`. Copiar del test de webhooks existente la forma de stubear el binding `AGENT` (buscar con `grep -rln "idFromName" test/`).

```ts
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { hmacHex } from "../../src/channels/shared";

const SECRET = "whsec_test";

function envWith(extra: any = {}) {
  const ingest = vi.fn().mockResolvedValue({ acknowledged: true });
  return {
    env: {
      WA_PROVIDER: "ycloud",
      YCLOUD_WEBHOOK_SECRET: SECRET,
      YCLOUD_API_KEY: "key",
      AGENT: { idFromName: () => "id", get: () => ({ ingest }) },
      ...extra,
    } as any,
    ingest,
  };
}

async function post(env: any, body: unknown, sign = true) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sign) {
    const t = Math.floor(Date.now() / 1000);
    headers["YCloud-Signature"] = `t=${t},s=${await hmacHex(SECRET, `${t}.${raw}`)}`;
  }
  return worker.fetch(
    new Request("https://bot.test/webhooks/whatsapp", { method: "POST", body: raw, headers }),
    env, {} as any,
  );
}

const inbound = {
  id: "ev_1",
  type: "whatsapp.inbound_message.received",
  whatsappInboundMessage: { from: "+525512345678", type: "text", text: { body: "hola" } },
};

describe("POST /webhooks/whatsapp con WA_PROVIDER=ycloud", () => {
  it("acepta firma válida y hace ingest", async () => {
    const { env, ingest } = envWith();
    const res = await post(env, inbound);
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0].channelUserId).toBe("525512345678");
  });

  it("rechaza sin firma con 403 y no hace ingest", async () => {
    const { env, ingest } = envWith();
    const res = await post(env, inbound, false);
    expect(res.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("responde 200 sin ingest a un evento de estado", async () => {
    const { env, ingest } = envWith();
    const res = await post(env, { id: "ev_2", type: "whatsapp.message.updated" });
    expect(res.status).toBe(200);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("GET /webhooks/whatsapp responde 404 (YCloud no hace handshake)", async () => {
    const { env } = envWith();
    const res = await worker.fetch(
      new Request("https://bot.test/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=x"),
      env, {} as any,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /webhooks/whatsapp con WA_PROVIDER=meta", () => {
  it("sigue exigiendo la firma de Meta", async () => {
    const { env, ingest } = envWith({ WA_PROVIDER: "meta", META_APP_SECRET: "meta_s" });
    const res = await post(env, inbound); // firmado al estilo YCloud
    expect(res.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `pnpm vitest run test/webhooks/whatsapp-dispatch.test.ts`
Expected: FAIL — con `WA_PROVIDER=ycloud` la ruta sigue validando firma de Meta y devuelve 403 en el primer test.

- [ ] **Step 3: Implementar el despacho**

En `src/index.ts`, agregar al import de la línea 8:

```ts
import { parseYCloudEvent, serveYCloudMedia, verifyYCloudSignature } from "./channels/ycloud";
```

Reemplazar el `GET /webhooks/whatsapp` (línea 133) para que respete el proveedor:

```ts
// GET = handshake de verificación de Meta. Solo aplica al Cloud API directo:
// YCloud no hace handshake, valida cada POST por firma.
app.get("/webhooks/whatsapp", (c) => {
  if ((c.env.WA_PROVIDER ?? "meta") === "ycloud") return c.notFound();
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expected = c.env.WHATSAPP_VERIFY_TOKEN || c.env.META_VERIFY_TOKEN;
  if (mode === "subscribe" && token && expected && token === expected) {
    return c.text(challenge ?? "", 200);
  }
  return c.text("forbidden", 403);
});
```

Y el `POST` (línea 146), agregando la rama de YCloud **antes** de la lógica actual:

```ts
app.post("/webhooks/whatsapp", async (c) => {
  const raw = await c.req.text();
  const provider = c.env.WA_PROVIDER ?? "meta";
  const origin = c.env.DASHBOARD_BASE_URL || new URL(c.req.url).origin;

  if (provider === "ycloud") {
    const ok = await verifyYCloudSignature(
      raw,
      c.req.header("YCloud-Signature"),
      c.env.YCLOUD_WEBHOOK_SECRET ?? "",
    );
    if (!ok) return c.text("bad signature", 403);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad json", 400);
    }
    // Un evento = un mensaje (YCloud no batchea). null = recibo de estado o
    // tipo no soportado: 200 igual, o YCloud reintenta.
    const msg = await parseYCloudEvent(body, c.env, origin);
    if (msg) {
      const doId = c.env.AGENT.idFromName(`${msg.channel}:${msg.channelUserId}`);
      await c.env.AGENT.get(doId).ingest(msg);
    }
    return c.text("EVENT_RECEIVED", 200);
  }

  // --- Cloud API directo de Meta (comportamiento original) ---
  const sig = c.req.header("x-hub-signature-256");
  const secret = c.env.WHATSAPP_APP_SECRET || c.env.META_APP_SECRET;
  const valid = !!secret && (await verifyMetaSignature(raw, sig, secret));
  if (!valid) return c.text("bad signature", 403);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.text("bad json", 400);
  }
  for (const msg of await parseWhatsAppEvents(body as any, c.env, origin)) {
    const doId = c.env.AGENT.idFromName(`${msg.channel}:${msg.channelUserId}`);
    await c.env.AGENT.get(doId).ingest(msg);
  }
  return c.text("EVENT_RECEIVED", 200);
});
```

Y agregar la ruta de media de YCloud **junto** a la de Meta (no en lugar de ella — son dos rutas distintas porque lo firmado es distinto, y Hono las distingue por el segmento de path):

```ts
// Proxy firmado del media de YCloud. Ruta separada de la de Meta porque allá
// se firma un media_id opaco (/media/:id) y aquí una URL (?u=...).
app.get("/webhooks/whatsapp/media", (c) =>
  serveYCloudMedia(c.req.query("u") ?? null, c.req.query("exp") ?? null, c.req.query("sig") ?? null, c.env),
);
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `pnpm vitest run test/webhooks/whatsapp-dispatch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Suite + typecheck**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/webhooks/whatsapp-dispatch.test.ts
git commit -m "Webhook de WhatsApp despacha según WA_PROVIDER

Con ycloud: firma propia y un evento por POST. Con meta: intacto. El
handshake GET solo existe para Meta. La ruta de media de YCloud convive
con la de Meta porque lo que se firma es distinto (URL vs media_id)."
```

---

### Task 10: Verificación final y documentación de operación

**Files:**
- Modify: `docs/superpowers/specs/2026-08-01-ycloud-whatsapp-adapter-design.md` (marcar criterios cumplidos)
- Create: `docs/canales/ycloud.md` (runbook del corte)

**Interfaces:**
- Consumes: todo lo anterior.

- [ ] **Step 1: Verificación completa**

Run: `pnpm test && pnpm typecheck`
Expected: **todos** verdes (446 previos + ~40 nuevos). Anotar el número exacto — es la evidencia, no el recuerdo.

- [ ] **Step 2: Verificar que no se rompió el default**

Run: `grep -n 'WA_PROVIDER' src/env.ts src/index.ts src/replies/sender.ts`
Expected: en los tres, el fallback es `"meta"`. Si en algún lado quedó `?? "ycloud"`, es un bug: rompería a los usuarios upstream.

- [ ] **Step 3: Verificar que no se agregó "ycloud" al union de canales**

Run: `grep -n 'ChannelId' src/channels/shared.ts`
Expected: el union sigue siendo `"manychat" | "telegram" | "twilio" | "messenger" | "instagram" | "whatsapp"`, sin `"ycloud"`.

- [ ] **Step 4: Escribir el runbook del corte**

Crear `docs/canales/ycloud.md` con: las 4 variables a configurar (`wrangler secret put YCLOUD_API_KEY`, `YCLOUD_WEBHOOK_SECRET`, y `WA_PROVIDER`/`YCLOUD_WA_FROM` como vars en `wrangler.toml`), y **el orden del corte, que importa**:

1. Deploy con `WA_PROVIDER=ycloud` y secrets cargados. Nadie apunta al Worker todavía → impacto cero.
2. Verificar `/health`.
3. Recién ahí, en YCloud, reemplazar el endpoint de LIA por `/webhooks/whatsapp`.

Al revés se abre una ventana en la que YCloud manda mensajes reales a un Worker que los rechaza con 403 — mensajes perdidos.

Incluir también el rollback: volver `WA_PROVIDER` a `meta` no basta (el webhook seguiría apuntando a Forja); hay que restaurar el endpoint de LIA en YCloud.

- [ ] **Step 5: Marcar los criterios de aceptación del spec**

Pasar a `[x]` los criterios cumplidos en el spec. Dejar en `[ ]` los que dependen de la Etapa B (corte), que **este plan no ejecuta**.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "Runbook del canal YCloud y criterios de aceptación

El orden del corte importa: primero deploy, después mover el webhook."
```

- [ ] **Step 7: PARAR — no ejecutar la Etapa B**

El corte a producción **no es parte de este plan**. Requiere primero la auditoría del workflow de LIA desde el workspace "Consultor BIRevX AAIA" (el único con `n8n-mcp`), tal como pide la cláusula de excepción registrada en `_context/decisions.md`.

Entregable de este plan: el adapter completo, testeado y desplegable, con el corte a un cambio de variable de distancia.

---

## Notas para quien ejecute

**Dependencias entre tareas:** la Task 5 está bloqueada por la Task 2 (necesita payloads reales). Las Tasks 3 y 4 no dependen de la captura y pueden hacerse mientras se coordina la ventana con el usuario. Las Tasks 6-9 dependen en cadena de la 5.

**La Task 2 requiere al usuario.** Toca n8n y el panel de YCloud, que el agente no opera. Detente y pide los pasos marcados `[USUARIO]`.

**Si un payload real contradice al spec, gana el payload.** La tabla de mapeo salió de la documentación de YCloud, que ya demostró ser imprecisa (usa `whatsappInboundMessage` y `whatsappMessage` en páginas distintas). Corrige el spec y sigue.

**Candidatos a PR upstream** (`santmun/forja`), sumados a los 5 hallazgos ya documentados: la Task 1 (Hallazgo 6 — learn-mode inalcanzable, es un bug) y el adapter completo (YCloud es BSP relevante en LATAM y `WA_PROVIDER` con default `meta` no rompe a nadie).
