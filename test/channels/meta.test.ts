import { describe, it, expect, vi, afterEach } from "vitest";
import { metaAdapter, parseMetaEvents } from "../../src/channels/meta";

afterEach(() => vi.restoreAllMocks());

describe("parseMetaEvents — providerMessageId", () => {
  it("conserva el mid del mensaje entrante", () => {
    const [msg] = parseMetaEvents({
      object: "page",
      entry: [{ messaging: [{ sender: { id: "psid-1" }, message: { mid: "mid.123", text: "hola" } }] }],
    } as any);
    expect(msg.channel).toBe("messenger");
    expect(msg.providerMessageId).toBe("mid.123");
  });
});

describe("metaAdapter.showTyping", () => {
  it("Messenger: manda mark_seen y typing_on como POSTs separados a la Página", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await metaAdapter.showTyping!("psid-1", { META_PAGE_ACCESS_TOKEN: "tok" } as any, {
      channel: "messenger",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toContain("https://graph.facebook.com/");
    expect(url).toContain("/me/messages");
    expect(JSON.parse(init.body)).toEqual({ recipient: { id: "psid-1" }, sender_action: "mark_seen" });
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body)).toEqual({
      recipient: { id: "psid-1" },
      sender_action: "typing_on",
    });
  });

  it("Instagram Login: sale por graph.instagram.com aunque también haya token de Página", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // primera llamada: resolución del user_id del hilo (instagramSenderId)
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "17841400000" }), { status: 200 }))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await metaAdapter.showTyping!(
      "igsid-1",
      { INSTAGRAM_ACCESS_TOKEN: "igtok", META_PAGE_ACCESS_TOKEN: "tok" } as any,
      { channel: "instagram" },
    );
    const urls = fetchMock.mock.calls.map((c: any) => String(c[0]));
    expect(urls.some((u) => u.startsWith("https://graph.instagram.com/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("https://graph.facebook.com/"))).toBe(false);
  });

  it("no lanza si Meta rechaza la acción (p. ej. IG Login sin soporte)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(
      metaAdapter.showTyping!("psid-1", { META_PAGE_ACCESS_TOKEN: "tok" } as any, { channel: "messenger" }),
    ).resolves.toBeUndefined();
  });
});
