import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyYCloudSignature, parseYCloudEvent, normalizePhone, serveYCloudMedia, ycloudAdapter } from "../../src/channels/ycloud";
import { hmacHex } from "../../src/channels/shared";
// Payload real capturado de tráfico de producción de LIA (n8n, 19 muestras,
// confirmado también en el panel de webhooks de YCloud). Es la fuente de
// verdad para el caso de texto — ver docs/superpowers/specs/ycloud-payloads-capturados.json.
import ycloudPayloads from "../../docs/superpowers/specs/ycloud-payloads-capturados.json";

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
  it("parsea texto y normaliza el teléfono (payload real capturado de producción)", async () => {
    const out = await parseYCloudEvent(ycloudPayloads.text, env, ORIGIN);
    expect(out).not.toBeNull();
    expect(out!.channel).toBe("whatsapp"); // NO "ycloud"
    expect(out!.channelUserId).toBe("524441796793"); // sin "+"
    expect(out!.text).toBe("gracias");
    expect(out!.displayName).toBe("Victor M. Cordero");
  });

  // Casos sintéticos: cubren formas mínimas (sin "id", sin campos extra) que
  // el payload real de abajo no ejercita. La forma en sí ya está verificada
  // contra tráfico real — ver los tests siguientes y
  // docs/superpowers/specs/ycloud-payloads-capturados.json.
  it("parsea imagen con caption y firma la URL de media (forma mínima)", async () => {
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

  it("parsea nota de voz (forma mínima, sin id)", async () => {
    const out = await parseYCloudEvent(
      evt({ from: "+525512345678", type: "audio",
            audio: { link: "https://api.ycloud.com/v2/whatsapp/media/download/xyz" } }),
      env, ORIGIN,
    );
    expect(out!.audioUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media?`);
    expect(out!.text).toBeUndefined();
  });

  it("parsea imagen con caption (payload real capturado de producción)", async () => {
    const out = await parseYCloudEvent(ycloudPayloads.image, env, ORIGIN);
    expect(out).not.toBeNull();
    expect(out!.channel).toBe("whatsapp");
    expect(out!.channelUserId).toBe("524441796793"); // sin "+", de from: "+524441796793"
    expect(out!.text).toBe("te comparto la SSD que llegó hoy");
    expect(out!.imageUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media?`);
    expect(out!.imageUrl).toMatch(/[?&]sig=/);
    expect(out!.imageUrl).toMatch(/[?&]exp=/);
    expect(out!.audioUrl).toBeUndefined();
  });

  it("parsea nota de voz (payload real capturado de producción)", async () => {
    const out = await parseYCloudEvent(ycloudPayloads.audio, env, ORIGIN);
    expect(out).not.toBeNull();
    expect(out!.channel).toBe("whatsapp");
    expect(out!.channelUserId).toBe("524441796793"); // sin "+", de from: "+524441796793"
    expect(out!.audioUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media?`);
    expect(out!.audioUrl).toMatch(/[?&]sig=/);
    expect(out!.audioUrl).toMatch(/[?&]exp=/);
    expect(out!.text).toBeUndefined();
    expect(out!.imageUrl).toBeUndefined();
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

  it("es defensiva si image/audio llegan sin link", async () => {
    expect(
      await parseYCloudEvent(evt({ from: "+525512345678", type: "image", image: { caption: "sin link" } }), env, ORIGIN),
    ).toBeNull();
    expect(
      await parseYCloudEvent(evt({ from: "+525512345678", type: "audio", audio: {} }), env, ORIGIN),
    ).toBeNull();
  });
});

afterEach(() => vi.restoreAllMocks());

async function signMedia(link: string, exp: number) {
  return hmacHex("whsec_test", `${link}.${exp}`);
}

describe("serveYCloudMedia", () => {
  const link = "https://api.ycloud.com/v2/whatsapp/media/download/abc";

  it("sirve los bytes con firma válida y manda la API key, sin seguir redirects", async () => {
    const exp = Date.now() + 60_000;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("BYTES", { status: 200, headers: { "Content-Type": "audio/ogg" } }),
    );
    const res = await serveYCloudMedia(link, String(exp), await signMedia(link, exp), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BYTES");
    const opts = fetchMock.mock.calls[0][1] as any;
    expect(opts.headers["X-API-Key"]).toBe("key");
    expect(opts.redirect).toBe("manual");
  });

  it("rechaza firma inválida con 403 sin llegar a golpear la red", async () => {
    const exp = Date.now() + 60_000;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await serveYCloudMedia(link, String(exp), "firmamala", env);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechaza una URL expirada con 410 sin llegar a golpear la red", async () => {
    const exp = Date.now() - 1000;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await serveYCloudMedia(link, String(exp), await signMedia(link, exp), env);
    expect(res.status).toBe(410);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechaza un host fuera de api.ycloud.com aunque la firma sea válida, sin llegar a golpear la red", async () => {
    const evil = "https://evil.example.com/robar";
    const exp = Date.now() + 60_000;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await serveYCloudMedia(evil, String(exp), await signMedia(evil, exp), env);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechaza un esquema distinto de https aunque el host sea válido, sin llegar a golpear la red", async () => {
    const ftpLink = "ftp://api.ycloud.com/v2/whatsapp/media/download/abc";
    const exp = Date.now() + 60_000;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await serveYCloudMedia(ftpLink, String(exp), await signMedia(ftpLink, exp), env);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 si no está configurado", async () => {
    const exp = Date.now() + 60_000;
    const res = await serveYCloudMedia(link, String(exp), await signMedia(link, exp), {} as any);
    expect(res.status).toBe(404);
  });

  it("devuelve 502 si el fetch saliente lanza (DNS, TLS, conexión)", async () => {
    const exp = Date.now() + 60_000;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network error"));
    const res = await serveYCloudMedia(link, String(exp), await signMedia(link, exp), env);
    expect(res.status).toBe(502);
  });
});

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
