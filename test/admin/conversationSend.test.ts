import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { sendChannelMessage } from "../../src/admin/conversationSend";

const sendReply = vi.fn(async () => {});
vi.mock("../../src/replies/sender", () => ({
  pickAdapter: () => ({ sendReply, showTyping: async () => {} }),
}));

let env: any;
let db: Db;
let convId: string;

beforeEach(async () => {
  sendReply.mockClear();
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  convId = (await new ConversationsRepo(db).getOrCreate("telegram", "u1")).id;
  env = { DB: d1 };
});

afterEach(() => vi.clearAllMocks());

describe("sendChannelMessage", () => {
  it("envía por el adapter y persiste el mensaje como 'owner'", async () => {
    const res = await sendChannelMessage(env, convId, "Tu cita quedó confirmada");
    expect(res.ok).toBe(true);
    expect(sendReply).toHaveBeenCalledTimes(1);

    const msgs = await new MessagesRepo(db).lastN(convId, 10);
    expect(msgs.some((m) => m.role === "owner" && m.content === "Tu cita quedó confirmada")).toBe(true);
  });

  it("error si la conversación no existe", async () => {
    const res = await sendChannelMessage(env, "telegram:999", "hola");
    expect(res.ok).toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("no persiste el mensaje si el envío falla", async () => {
    sendReply.mockRejectedValueOnce(new Error("canal caído"));
    const res = await sendChannelMessage(env, convId, "no debería guardarse");
    expect(res.ok).toBe(false);

    const msgs = await new MessagesRepo(db).lastN(convId, 10);
    expect(msgs.some((m) => m.content === "no debería guardarse")).toBe(false);
  });
});
