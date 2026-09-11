import { describe, it, expect, vi, afterEach } from "vitest";
import { metaAdapter } from "../../src/channels/meta";
import { manychatAdapter } from "../../src/channels/manychat";
import { twilioAdapter } from "../../src/channels/twilio";
import type { OutgoingReply } from "../../src/channels/shared";

/**
 * Contrato de formato POR CANAL.
 *
 * El upstream saneaba el Markdown en `chunkReply` (embudo único) partiendo de
 * que "ningún canal renderiza Markdown". No es exacto: Telegram y WhatsApp sí
 * renderizan negrita, con *un* asterisco. Estas pruebas fijan la regla real:
 *   - canal con dialecto  → se traduce (** → *)
 *   - canal sin marcado   → se aplana (** se quita)
 * para que nadie vuelva a mover el saneado al embudo y apague la negrita.
 */

afterEach(() => vi.restoreAllMocks());

const reply = (channel: any): OutgoingReply =>
  ({ channel, channelUserId: "u1", chunks: ["Tu cita quedó **confirmada**"] }) as OutgoingReply;

describe("formato por canal", () => {
  it("Messenger aplana la negrita (no renderiza marcado)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await metaAdapter.sendReply!(reply("messenger"), { META_PAGE_ACCESS_TOKEN: "t" } as any);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body));
    expect(body.message.text).toBe("Tu cita quedó confirmada");
  });

  it("ManyChat aplana la negrita (entrega a IG/Messenger)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await manychatAdapter.sendReply!(reply("manychat"), { MANYCHAT_API_KEY: "k" } as any);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body));
    expect(body.data.content.messages[0].text).toBe("Tu cita quedó confirmada");
  });

  it("Twilio traduce al dialecto de WhatsApp (un asterisco), no aplana", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await twilioAdapter.sendReply!(reply("twilio"), {
      TWILIO_ACCOUNT_SID: "AC",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_WA_FROM: "+5215500000",
    } as any);
    const sent = String((fetchMock.mock.calls[0] as any[])[1].body);
    expect(decodeURIComponent(sent)).toContain("*confirmada*");
    expect(decodeURIComponent(sent)).not.toContain("**confirmada**");
  });
});
