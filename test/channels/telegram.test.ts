import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { telegramAdapter, resolveTelegramFileUrl, toTelegramMarkdown } from "../../src/channels/telegram";
import type { Env } from "../../src/env";

function makeReq(body: unknown): Request {
  return new Request("https://bot.test/webhooks/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const env = { TELEGRAM_BOT_TOKEN: "test-token" } as Env;

// Telegram media (voice/photo) is NOT directly addressable by file_id — the
// adapter must call getFile to obtain a file_path, then build the download URL.
// So media tests mock fetch to stand in for that getFile call.
function mockGetFile(filePath: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { file_path: filePath } }), {
      status: 200,
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegramAdapter.parseIncoming", () => {
  it("parses a text message (no fetch needed)", async () => {
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          text: "hola",
        },
      }),
      env,
    );
    expect(msg.channel).toBe("telegram");
    expect(msg.channelUserId).toBe("555");
    expect(msg.text).toBe("hola");
    expect(msg.displayName).toBe("Ana");
  });

  it("resolves voice notes to a real download URL via getFile", async () => {
    mockGetFile("voice/file_5.oga");
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 2,
        message: {
          message_id: 11,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          voice: { file_id: "voice-abc", duration: 5 },
        },
      }),
      env,
    );
    // The resolved URL is the downloadable HTTPS path, not the raw file_id.
    expect(msg.audioUrl).toBe(
      "https://api.telegram.org/file/bottest-token/voice/file_5.oga",
    );
  });

  it("resolves photos to a real download URL + uses caption as text", async () => {
    mockGetFile("photos/file_9.jpg");
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 3,
        message: {
          message_id: 12,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          photo: [
            { file_id: "photo-small", width: 90, height: 90 },
            { file_id: "photo-large", width: 800, height: 800 },
          ],
          caption: "mira esto",
        },
      }),
      env,
    );
    expect(msg.imageUrl).toBe(
      "https://api.telegram.org/file/bottest-token/photos/file_9.jpg",
    );
    expect(msg.text).toBe("mira esto");
  });

  it("flags the owner's own message via OWNER_TELEGRAM_CHAT_ID", async () => {
    const ownerEnv = { TELEGRAM_BOT_TOKEN: "t", OWNER_TELEGRAM_CHAT_ID: "999" } as Env;
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 4,
        message: {
          message_id: 13,
          from: { id: 999, first_name: "Dueño", is_bot: false },
          chat: { id: 999, type: "private" },
          date: 100,
          text: "yo me encargo",
        },
      }),
      ownerEnv,
    );
    expect(msg.isOwnerMessage).toBe(true);
  });
});

describe("resolveTelegramFileUrl", () => {
  it("returns null when getFile fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 400 }));
    const url = await resolveTelegramFileUrl("x", "tok");
    expect(url).toBeNull();
  });
});

describe("toTelegramMarkdown", () => {
  it("converts CommonMark bold (**x**) to Telegram legacy bold (*x*)", () => {
    expect(toTelegramMarkdown("El **precio** es fijo")).toBe("El *precio* es fijo");
  });

  it("converts CommonMark italic (*x*) to Telegram italic (_x_)", () => {
    expect(toTelegramMarkdown("tu *propio* ritmo")).toBe("tu _propio_ ritmo");
  });

  it("handles bold and italic together without cross-matching", () => {
    expect(toTelegramMarkdown("**Next step:** ve a tu *propio* ritmo")).toBe(
      "*Next step:* ve a tu _propio_ ritmo",
    );
  });

  it("handles multiple bold spans in the same message", () => {
    expect(toTelegramMarkdown("**Uno** y **dos** y **tres**")).toBe("*Uno* y *dos* y *tres*");
  });

  it("leaves plain text without asterisks unchanged", () => {
    expect(toTelegramMarkdown("Hola, ¿en qué te ayudo?")).toBe("Hola, ¿en qué te ayudo?");
  });
});

describe("telegramAdapter.sendReply — botones (skill /botones)", () => {
  afterEach(() => vi.restoreAllMocks());

  // sendReply manda un POST a sendChatAction (typing) ANTES de cada
  // sendMessage — filtrar por URL evita depender del índice crudo de la llamada.
  function sendMessageCalls(fetchMock: ReturnType<typeof vi.spyOn>) {
    return (fetchMock.mock.calls as any[]).filter(([url]) => String(url).includes("/sendMessage"));
  }

  it("manda reply_markup con teclado de una sola vez cuando hay buttons", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendReply(
      {
        channel: "telegram",
        channelUserId: "42",
        chunks: ["¿Confirmamos?"],
        buttons: [{ title: "Sí", payload: "btn:Sí" }, { title: "No", payload: "btn:No" }],
      },
      { TELEGRAM_BOT_TOKEN: "tok" } as any,
    );
    const [, init] = sendMessageCalls(fetchMock)[0];
    const body = JSON.parse(init.body);
    expect(body.reply_markup).toEqual({
      keyboard: [[{ text: "Sí" }], [{ text: "No" }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    });
  });

  it("solo el ÚLTIMO chunk lleva reply_markup", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendReply(
      {
        channel: "telegram",
        channelUserId: "42",
        chunks: ["primero", "segundo"],
        buttons: [{ title: "Sí", payload: "btn:Sí" }],
        interChunkDelayMs: 0,
      },
      { TELEGRAM_BOT_TOKEN: "tok" } as any,
    );
    const [firstCall, secondCall] = sendMessageCalls(fetchMock);
    const first = JSON.parse(firstCall[1].body);
    const second = JSON.parse(secondCall[1].body);
    expect(first.reply_markup).toBeUndefined();
    expect(second.reply_markup).toBeDefined();
  });

  it("sin buttons no manda reply_markup", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendReply(
      { channel: "telegram", channelUserId: "42", chunks: ["hola"] },
      { TELEGRAM_BOT_TOKEN: "tok" } as any,
    );
    const body = JSON.parse(sendMessageCalls(fetchMock)[0][1].body);
    expect(body.reply_markup).toBeUndefined();
  });

  it("el fallback a texto plano (parse_mode rechazado) también conserva reply_markup", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let sendMessageCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      if (String(url).includes("/sendChatAction")) return new Response("{}", { status: 200 });
      // Primer sendMessage (parse_mode Markdown) rechazado; el fallback en
      // texto plano (segundo sendMessage) sí responde 200.
      sendMessageCount++;
      return sendMessageCount === 1
        ? new Response("bad entity", { status: 400 })
        : new Response("{}", { status: 200 });
    });
    await telegramAdapter.sendReply(
      {
        channel: "telegram",
        channelUserId: "42",
        chunks: ["texto"],
        buttons: [{ title: "Sí", payload: "btn:Sí" }],
      },
      { TELEGRAM_BOT_TOKEN: "tok" } as any,
    );
    const msgCalls = sendMessageCalls(fetchMock);
    expect(msgCalls).toHaveLength(2); // intento con parse_mode + fallback en texto plano
    const fallbackBody = JSON.parse(msgCalls[1][1].body);
    expect(fallbackBody.reply_markup).toBeDefined();
  });
});

describe("telegramAdapter.sendDocument", () => {
  afterEach(() => vi.restoreAllMocks());

  it("manda el documento con la URL directa y caption", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendDocument!(
      { channel: "telegram", channelUserId: "42", url: "https://bot.example/files/web?exp=1&sig=a", filename: "x.pdf", mimeType: "application/pdf", caption: "Paquetes" },
      { TELEGRAM_BOT_TOKEN: "tok" } as any,
    );
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toContain("/sendDocument");
    expect(JSON.parse(init.body)).toEqual({
      chat_id: "42",
      document: "https://bot.example/files/web?exp=1&sig=a",
      caption: "Paquetes",
    });
  });

  it("no llama a nada sin token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendDocument!(
      { channel: "telegram", channelUserId: "42", url: "https://x/y", filename: "x.pdf", mimeType: "application/pdf" },
      {} as any,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no lanza si Telegram responde error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(
      telegramAdapter.sendDocument!(
        { channel: "telegram", channelUserId: "42", url: "https://x/y", filename: "x.pdf", mimeType: "application/pdf" },
        { TELEGRAM_BOT_TOKEN: "tok" } as any,
      ),
    ).resolves.toBeUndefined();
  });
});

