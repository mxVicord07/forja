import { describe, it, expect } from "vitest";
import { hmacHex, timingSafeEqual, normalizePhone } from "../../src/channels/shared";
import { parseYCloudEvent } from "../../src/channels/ycloud";
import { parseWhatsAppEvents } from "../../src/channels/whatsapp";

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

describe("normalizePhone", () => {
  it("deja solo dígitos, sin importar el formato de entrada", () => {
    expect(normalizePhone("+52 444 179 6793")).toBe("524441796793");
    expect(normalizePhone("524441796793")).toBe("524441796793");
  });
});

// Test de paridad: protege la garantía de migración de proveedor (ver
// comentario de normalizePhone en shared.ts). Vive acá y no en
// ycloud.test.ts o whatsapp.test.ts porque prueba una propiedad que
// relaciona a AMBOS adapters, no el comportamiento de uno solo — y shared.ts
// es justamente el módulo dueño de esa garantía compartida.
describe("paridad de channelUserId entre adapters de WhatsApp", () => {
  const ORIGIN = "https://bot.example.workers.dev";

  it("YCloud (E.164 con '+') y Meta Cloud API (sin '+') producen el mismo channelUserId para el mismo número", async () => {
    const ycloudMsg = await parseYCloudEvent(
      {
        id: "ev_1",
        type: "whatsapp.inbound_message.received",
        whatsappInboundMessage: {
          from: "+524441796793",
          type: "text",
          text: { body: "hola" },
        },
      },
      {} as any,
      ORIGIN,
    );

    const metaBody = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
                messages: [{ from: "524441796793", id: "wamid.1", type: "text", text: { body: "hola" } }],
              },
            },
          ],
        },
      ],
    };
    const [metaMsg] = await parseWhatsAppEvents(metaBody as any, {} as any, ORIGIN);

    expect(ycloudMsg).not.toBeNull();
    expect(metaMsg).not.toBeUndefined();
    expect(ycloudMsg!.channelUserId).toBe(metaMsg.channelUserId);
    expect(ycloudMsg!.channelUserId).toBe("524441796793");
  });
});
