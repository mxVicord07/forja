import { describe, it, expect, vi } from "vitest";

// `src/index.ts` re-exports `SupportAgent` from `./agent`, que importa el SDK
// `agents`. `agents` (vía `partyserver`) importa el módulo virtual
// `cloudflare:workers` al cargar, que el loader ESM de Node no puede resolver
// fuera de workerd. Se mockea `agents` para que el grafo de imports se quede
// en Node-land — acá solo se ejercita el router de Hono.
vi.mock("agents", () => ({ Agent: class {} }));

import worker from "../../src/index";
import { hmacHex } from "../../src/channels/shared";
import { resolveWaProvider } from "../../src/replies/sender";
import { pickAdapter } from "../../src/replies/sender";
import { whatsappAdapter } from "../../src/channels/whatsapp";
import { ycloudAdapter, parseYCloudEvent } from "../../src/channels/ycloud";

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

// signedMediaUrl (ycloud.ts) emite `u` con encodeURIComponent y firma el HMAC
// sobre la URL SIN codificar. Si la ruta le pasara a serveYCloudMedia el valor
// tal cual llega codificado, la firma nunca cerraría y todo el media legítimo
// daría 403. Prueba de extremo a extremo real: genera la URL firmada con
// parseYCloudEvent (como haría el webhook de verdad) y la sirve a través del
// router de Hono — no asume que c.req.query("u") decodifica, lo verifica.
describe("GET /webhooks/whatsapp/media (YCloud) — extremo a extremo con signedMediaUrl", () => {
  it("una URL firmada por signedMediaUrl con caracteres especiales se sirve en 200", async () => {
    const ORIGIN = "https://bot.test";
    const env = {
      WA_PROVIDER: "ycloud",
      YCLOUD_WEBHOOK_SECRET: SECRET,
      YCLOUD_API_KEY: "key",
      DASHBOARD_BASE_URL: ORIGIN,
    } as any;
    // El link real de YCloud trae query string propia (token, versión) — son
    // justo los caracteres (& =) que encodeURIComponent codifica y que, si no
    // se decodifican de vuelta antes de recalcular el HMAC, rompen la firma.
    const link = "https://api.ycloud.com/v2/whatsapp/media/download/abc?token=xy z&v=2";
    const event = {
      id: "ev_media",
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: {
        from: "+525512345678",
        type: "image",
        image: { link, caption: "foto" },
      },
    };
    const msg = await parseYCloudEvent(event, env, ORIGIN);
    expect(msg?.imageUrl).toBeTruthy();
    expect(msg!.imageUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media?u=`);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("BYTES", { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    );
    const res = await worker.fetch(new Request(msg!.imageUrl!), env, {} as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BYTES");
    // Confirma que lo que se le pidió al origen fue el link SIN codificar.
    expect(fetchMock.mock.calls[0][0]).toBe(link);
    fetchMock.mockRestore();
  });
});

describe("POST /webhooks/whatsapp con WA_PROVIDER=meta", () => {
  it("sigue exigiendo la firma de Meta", async () => {
    const { env, ingest } = envWith({ WA_PROVIDER: "meta", META_APP_SECRET: "meta_s" });
    const res = await post(env, inbound); // firmado al estilo YCloud
    expect(res.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("el handshake GET sigue funcionando igual que antes", async () => {
    const { env } = envWith({ WA_PROVIDER: "meta", WHATSAPP_VERIFY_TOKEN: "tok" });
    const res = await worker.fetch(
      new Request("https://bot.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=xyz"),
      env, {} as any,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("xyz");
  });
});

// Protege contra el peor bug posible: recibir por un proveedor y responder
// por otro. Ambos lados (entrada del webhook, salida de sender.ts) deben leer
// WA_PROVIDER a través del mismo `resolveWaProvider` — si uno normalizara
// distinto (mayúsculas, espacios), el mensaje entraría por YCloud y la
// respuesta se intentaría mandar por Meta (o viceversa), y el usuario nunca
// vería la respuesta.
describe("resolveWaProvider — coherencia entrada/salida", () => {
  const cases: Array<[string | undefined, "ycloud" | "meta"]> = [
    ["ycloud", "ycloud"],
    ["YCloud", "ycloud"],
    [" ycloud ", "ycloud"],
    ["meta", "meta"],
    ["META", "meta"],
    [undefined, "meta"],
    ["yclod", "meta"], // typo — degrada a meta, no lanza
  ];

  for (const [raw, expected] of cases) {
    it(`WA_PROVIDER=${JSON.stringify(raw)} resuelve "${expected}" en ambos lados`, () => {
      const env = { WA_PROVIDER: raw } as any;
      const resolved = resolveWaProvider(env);
      expect(resolved).toBe(expected);

      const outboundAdapter = pickAdapter("whatsapp", env);
      const expectedAdapter = expected === "ycloud" ? ycloudAdapter : whatsappAdapter;
      expect(outboundAdapter).toBe(expectedAdapter);
    });
  }

  it("un valor no reconocido hace console.error y no lanza", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => resolveWaProvider({ WA_PROVIDER: "yclod" } as any)).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
