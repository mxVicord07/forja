import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyYCloudSignature, parseYCloudEvent, normalizePhone, serveYCloudMedia } from "../../src/channels/ycloud";
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

  // La forma de image/audio abajo sale de la documentación de YCloud, NO de un
  // payload real (no hay ninguno en las 19 muestras capturadas) — ver
  // docs/superpowers/specs/ycloud-payloads-capturados.json → _pendiente_de_verificar.
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

  it("es defensiva si image/audio llegan sin link (forma no verificada)", async () => {
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
