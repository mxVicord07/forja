import { describe, it, expect, vi, beforeEach } from "vitest";

// Mismo andamiaje que test/agent.media.test.ts: el paquete `agents` importa
// `cloudflare:workers`, que Node no resuelve; se reemplaza por una base mínima.
vi.mock("agents", () => ({
  Agent: class {
    ctx: any;
    env: any;
    state: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    setState(s: any) {
      this.state = s;
    }
    sql(..._args: any[]) {
      return undefined;
    }
  },
}));

const streamTextMock = vi.fn();
vi.mock("ai", () => ({
  streamText: (...args: any[]) => streamTextMock(...args),
  generateText: vi.fn(),
  tool: (def: any) => def,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

import { SupportAgent } from "../src/agent";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { SettingsRepo } from "../src/db/settings";
import * as senderMod from "../src/replies/sender";
import * as verifyMod from "../src/blindaje/verify";

function makeStreamResult(text: string) {
  async function* gen() {
    yield text;
  }
  return {
    textStream: gen(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }),
    steps: Promise.resolve([{ toolCalls: [] }]),
  };
}

function makeAgent() {
  const storage = { setAlarm: vi.fn(), getAlarm: vi.fn(async () => 1) };
  const env: any = {
    DB: {},
    ANTHROPIC_API_KEY: "sk-test",
    BOT_TIER: "free",
    BOT_LANGUAGE: "es",
    BUFFER_SECONDS: "8",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "TestCo",
  };
  const agent: any = new (SupportAgent as any)({ storage }, env);
  agent.setState({
    conversationId: "conv-1",
    channel: "whatsapp",
    channelUserId: "524441796793",
    pendingMessages: [],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
    lastProviderMessageId: "",
  });
  return { agent, env, storage };
}

function stubBase(opts?: { paused?: boolean }) {
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
  vi.spyOn(ConversationsRepo.prototype, "getOrCreate").mockResolvedValue({ id: "conv-1", paused_until: null } as any);
  vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(opts?.paused ?? false);
  vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
  vi.spyOn(ConversationsRepo.prototype, "setTakenBy").mockResolvedValue(undefined as any);
}

const HORA = 60 * 60 * 1000;

describe("Relevo: el dueño escribe desde la app y le pasa la conversación al bot (I-023, R1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("con la frase de relevo NO pausa: suelta la conversación y marca el relevo", async () => {
    const { agent } = makeAgent();
    stubBase();
    const setPaused = vi.spyOn(ConversationsRepo.prototype, "setPausedUntil").mockResolvedValue(undefined);
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-owner" as any);

    await agent.ingest({
      channel: "whatsapp",
      channelUserId: "524441796793",
      text: "Hugo, te comparto la propuesta actualizada. Te dejo con Lía, mi asistente, para lo que necesites.",
      isOwnerMessage: true,
    });

    expect(setPaused).toHaveBeenCalledWith("conv-1", null);
    expect(append).toHaveBeenCalledWith("conv-1", "owner", expect.stringContaining("Te dejo con Lía"));
    expect(agent.state.relevoAt).toBeGreaterThan(Date.now() - 5000);
  });

  it("sin la frase, el mensaje del dueño pausa una hora como siempre y no marca relevo", async () => {
    const { agent } = makeAgent();
    stubBase();
    const setPaused = vi.spyOn(ConversationsRepo.prototype, "setPausedUntil").mockResolvedValue(undefined);
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-owner" as any);

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "te marco en 5", isOwnerMessage: true });

    const [, hasta] = setPaused.mock.calls[0];
    expect(hasta).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    expect(agent.state.relevoAt).toBeUndefined();
  });

  it("lo que escribe el cliente durante la pausa se guarda en el historial y queda pendiente, sin responder", async () => {
    const { agent, storage } = makeAgent();
    stubBase({ paused: true });
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-cli-1" as any);

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "Gracias Víctor, ¿el anticipo puede ser en dos partes?" });

    expect(append).toHaveBeenCalledWith("conv-1", "user", "Gracias Víctor, ¿el anticipo puede ser en dos partes?");
    expect(agent.state.pauseBacklog).toEqual([
      { id: "m-cli-1", text: "Gracias Víctor, ¿el anticipo puede ser en dos partes?", receivedAt: expect.any(Number) },
    ]);
    expect(agent.state.pendingMessages).toHaveLength(0);
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("un audio o una imagen durante la pausa se anotan como tales", async () => {
    const { agent } = makeAgent();
    stubBase({ paused: true });
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-cli-2" as any);

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", audioUrl: "https://x/a.ogg" });

    expect(append).toHaveBeenCalledWith("conv-1", "user", "(el cliente mandó un audio)");
  });

  it("si el dueño vuelve a escribir, lo pendiente de la pausa ya está atendido", async () => {
    const { agent } = makeAgent();
    stubBase();
    vi.spyOn(ConversationsRepo.prototype, "setPausedUntil").mockResolvedValue(undefined);
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-owner" as any);
    agent.setState({ ...agent.state, pauseBacklog: [{ id: "m1", text: "¿y el anticipo?", receivedAt: Date.now() }] });

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "Sí, en dos partes", isOwnerMessage: true });

    expect(agent.state.pauseBacklog).toEqual([]);
  });

  it("al seguir la conversación normal (pausa vencida) lo pendiente deja de estarlo: ya está en el historial", async () => {
    const { agent } = makeAgent();
    stubBase({ paused: false });
    agent.setState({ ...agent.state, pauseBacklog: [{ id: "m1", text: "¿y el anticipo?", receivedAt: Date.now() - HORA }] });

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "¿sigues ahí?" });

    expect(agent.state.pauseBacklog).toEqual([]);
    expect(agent.state.pendingMessages.map((m: any) => m.text)).toEqual(["¿sigues ahí?"]);
  });
});

describe("resumeAfterRelease: el dueño devuelve la conversación al bot a propósito", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
  });

  it("si después de la pausa lo último ya no es del cliente (el dueño contestó en Inbox), no responde", async () => {
    const { agent, storage } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "owner", content: "Sí, en dos partes" }] as any);
    agent.setState({ ...agent.state, pauseBacklog: [{ id: "m1", text: "¿y el anticipo?", receivedAt: Date.now() - HORA }] });

    expect(await agent.resumeAfterRelease()).toEqual({ responde: false, motivo: "atendido" });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("con mensajes del cliente de menos de 12 h, los manda a responder sin volver a guardarlos", async () => {
    const { agent, storage } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: "¿y el anticipo?" }] as any);
    const ahora = Date.now();
    agent.setState({ ...agent.state, pauseBacklog: [{ id: "m1", text: "¿y el anticipo?", receivedAt: ahora - 2 * HORA }] });

    const r = await agent.resumeAfterRelease();

    expect(r).toEqual({ responde: true });
    expect(agent.state.pauseBacklog).toEqual([]);
    expect(agent.state.pendingMessages).toEqual([{ text: "¿y el anticipo?", receivedAt: ahora - 2 * HORA, persistedId: "m1" }]);
    expect(storage.setAlarm).toHaveBeenCalled();
  });

  it("con mensajes de más de 12 h no responde fuera de tiempo: quedan como contexto", async () => {
    const { agent, storage } = makeAgent();
    agent.setState({ ...agent.state, pauseBacklog: [{ id: "m1", text: "ok gracias", receivedAt: Date.now() - 13 * HORA }] });

    const r = await agent.resumeAfterRelease();

    expect(r).toEqual({ responde: false, motivo: "viejo" });
    expect(agent.state.pauseBacklog).toEqual([]);
    expect(agent.state.pendingMessages).toHaveLength(0);
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("sin nada pendiente no hace nada", async () => {
    const { agent, storage } = makeAgent();
    expect(await agent.resumeAfterRelease()).toEqual({ responde: false, motivo: "sin_pendientes" });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });
});

describe("processBuffer con mensajes ya guardados durante la pausa", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply: vi.fn(async () => {}) } as any);
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult("Claro, te explico."));
  });

  it("no vuelve a guardar lo que ya está en el historial, pero sí responde", async () => {
    const { agent } = makeAgent();
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-bot" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: "¿y el anticipo?" }] as any);
    agent.state.pendingMessages = [{ text: "¿y el anticipo?", receivedAt: Date.now(), persistedId: "m1" }];

    await agent.processBuffer();

    expect(append.mock.calls.filter((c) => c[1] === "user")).toHaveLength(0);
    expect(streamTextMock).toHaveBeenCalled();
  });

  it("si además llegó un mensaje nuevo, solo guarda el nuevo", async () => {
    const { agent } = makeAgent();
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-x" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "¿y el anticipo?" },
      { role: "user", content: "¿hola?" },
    ] as any);
    agent.state.pendingMessages = [
      { text: "¿y el anticipo?", receivedAt: Date.now() - 1000, persistedId: "m1" },
      { text: "¿hola?", receivedAt: Date.now() },
    ];

    await agent.processBuffer();

    expect(append.mock.calls.filter((c) => c[1] === "user").map((c) => c[2])).toEqual(["¿hola?"]);
  });

  it("en relevo, el prompt lleva el bloque <relevo> con lo último que escribió el dueño", async () => {
    const { agent } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-x" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "owner", content: "Hugo, va la propuesta v2. Te dejo con Lía." },
      { role: "user", content: "¿qué incluye?" },
    ] as any);
    agent.state.relevoAt = Date.now() - HORA;
    agent.state.pendingMessages = [{ text: "¿qué incluye?", receivedAt: Date.now() }];

    await agent.processBuffer();

    const llamada = JSON.stringify(streamTextMock.mock.calls[0][0].system);
    expect(llamada).toContain("<relevo>");
    expect(llamada).toContain("Hugo, va la propuesta v2.");
  });

  it("el blindaje recibe la ficha y lo último del dueño como fuentes, y sabe que hay relevo", async () => {
    const { agent } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-x" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "owner", content: "Te armé una propuesta: $17,500 más $3,500 al mes, más IVA." },
      { role: "owner", content: "Te dejo con Lía, mi asistente, para lo que necesites." },
      { role: "user", content: "es mucho para arrancar" },
    ] as any);
    vi.spyOn(SettingsRepo.prototype, "get").mockResolvedValue(null as any);
    const guard = vi
      .spyOn(verifyMod, "guardReply")
      .mockResolvedValue({ finalText: "Claro, te explico.", action: "sent-original" } as any);
    agent.state.relevoAt = Date.now() - HORA;
    agent.state.crmFichaAt = Date.now();
    agent.state.crmFicha = {
      lead: { id: 126, titulo: "Voz", tipo: "lead", etapa_clave: "New", etapa: "Nuevo", monto: 0, etiquetas: [], empresa: null, contacto: "Manuel", resumen_ultima_interaccion: null, ultimo_contacto: null, proxima_actividad: null, brief: "Clínica de rehabilitación" },
      cotizacion: { folio: "S00099", estado: "enviada", monto_sin_iva: 17500, vigencia: null },
      interacciones: [],
    };
    agent.state.pendingMessages = [{ text: "es mucho para arrancar", receivedAt: Date.now() }];

    await agent.processBuffer();

    const opts = guard.mock.calls[0][1] as any;
    expect(opts.relevo).toBe(true);
    expect(opts.extraSources).toContain("S00099");
    expect(opts.extraSources).toContain("Clínica de rehabilitación");
    // la cifra va en un mensaje anterior al de "te dejo con Lía": también cuenta
    expect(opts.extraSources).toContain("$17,500 más $3,500 al mes");
    expect(opts.extraSources).toContain("Te dejo con Lía");
  });

  it("los textos de reemplazo del blindaje no llegan al modelo como si fueran suyos (los copiaba)", async () => {
    const { agent } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-x" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "assistant", content: verifyMod.safeConfirmReply("es") },
      { role: "assistant", content: verifyMod.safeConfirmReply("es", { relevo: true }) },
      { role: "user", content: "la mensualidad" },
    ] as any);
    agent.state.pendingMessages = [{ text: "la mensualidad", receivedAt: Date.now() }];

    await agent.processBuffer();

    const enviado = JSON.stringify(streamTextMock.mock.calls[0][0].messages);
    expect(enviado).not.toContain("Esa me la confirma el equipo");
    expect(enviado).not.toContain("quien te atendió");
    expect(enviado).toContain("confirmaría con el dueño");
  });

  it("sin relevo ni propuesta enviada, no hay bloque <relevo>", async () => {
    const { agent } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-x" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: "hola" }] as any);
    agent.state.pendingMessages = [{ text: "hola", receivedAt: Date.now() }];

    await agent.processBuffer();

    expect(JSON.stringify(streamTextMock.mock.calls[0][0].system)).not.toContain("<relevo>");
  });
});

describe("Relevo: hallazgos de la auditoría del 1-nov", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("tras la frase, otro mensaje del dueño en los siguientes minutos (el PDF, un saludo) no vuelve a pausar", async () => {
    const { agent } = makeAgent();
    stubBase();
    const setPaused = vi.spyOn(ConversationsRepo.prototype, "setPausedUntil").mockResolvedValue(undefined);
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m" as any);
    agent.setState({ ...agent.state, relevoAt: Date.now() - 60_000 });

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", isOwnerMessage: true });

    expect(setPaused).toHaveBeenCalledWith("conv-1", null);
  });

  it("pasados esos minutos, un mensaje del dueño sin la frase vuelve a pausar", async () => {
    const { agent } = makeAgent();
    stubBase();
    const setPaused = vi.spyOn(ConversationsRepo.prototype, "setPausedUntil").mockResolvedValue(undefined);
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m" as any);
    agent.setState({ ...agent.state, relevoAt: Date.now() - 2 * HORA });

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "yo te marco", isOwnerMessage: true });

    expect(setPaused.mock.calls[0][1]).toBeGreaterThan(Date.now());
  });

  it("la frase de relevo también quita la marca de 'tomada' en Inbox", async () => {
    const { agent } = makeAgent();
    stubBase();
    vi.spyOn(ConversationsRepo.prototype, "setPausedUntil").mockResolvedValue(undefined);
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m" as any);
    const taken = vi.spyOn(ConversationsRepo.prototype, "setTakenBy");

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "Te dejo con Lía.", isOwnerMessage: true });

    expect(taken).toHaveBeenCalledWith("conv-1", null);
  });

  it("el dueño no vuelve a guardar como del cliente lo que ya estaba guardado de la pausa", async () => {
    const { agent } = makeAgent();
    stubBase();
    vi.spyOn(ConversationsRepo.prototype, "setPausedUntil").mockResolvedValue(undefined);
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m" as any);
    agent.setState({ ...agent.state, pendingMessages: [{ text: "¿y el anticipo?", receivedAt: Date.now(), persistedId: "m1" }] });

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "va en dos partes", isOwnerMessage: true });

    expect(append.mock.calls.filter((c) => c[1] === "user")).toHaveLength(0);
  });

  it("el pendiente de la pausa tiene tope de 20 (se quedan los más recientes)", async () => {
    const { agent } = makeAgent();
    stubBase({ paused: true });
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m-nuevo" as any);
    agent.setState({
      ...agent.state,
      pauseBacklog: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, text: `t${i}`, receivedAt: Date.now() })),
    });

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "uno más" });

    expect(agent.state.pauseBacklog).toHaveLength(20);
    expect(agent.state.pauseBacklog[0].id).toBe("m1");
    expect(agent.state.pauseBacklog[19].id).toBe("m-nuevo");
  });

  it("un reintento del mismo mensaje del proveedor durante la pausa no se guarda dos veces", async () => {
    const { agent } = makeAgent();
    stubBase({ paused: true });
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m1" as any);
    const msg = { channel: "whatsapp", channelUserId: "524441796793", providerMessageId: "wamid.A", text: "¿y el anticipo?" };

    await agent.ingest(msg);
    await agent.ingest(msg);

    expect(append).toHaveBeenCalledTimes(1);
  });

  it("una imagen con pie de foto durante la pausa guarda el pie y avisa que hubo imagen", async () => {
    const { agent } = makeAgent();
    stubBase({ paused: true });
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m1" as any);

    await agent.ingest({ channel: "whatsapp", channelUserId: "524441796793", text: "así está hoy", imageUrl: "https://x/i.jpg" });

    expect(append).toHaveBeenCalledWith("conv-1", "user", "así está hoy (con una imagen)");
  });

  it("al devolver la conversación, una nota interna al final no cuenta como respuesta al cliente", async () => {
    const { agent, storage } = makeAgent();
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "¿y el anticipo?" },
      { role: "note", content: "dile que sí en dos partes" },
    ] as any);
    agent.setState({ ...agent.state, pauseBacklog: [{ id: "m1", text: "¿y el anticipo?", receivedAt: Date.now() - HORA }] });

    expect(await agent.resumeAfterRelease()).toEqual({ responde: true });
    expect(storage.setAlarm).toHaveBeenCalled();
  });

  it("con el bot apagado desde el panel, devolver la conversación no responde", async () => {
    const { agent, storage } = makeAgent();
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({ bot_paused: "1" });
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: "¿y el anticipo?" }] as any);
    agent.setState({ ...agent.state, pauseBacklog: [{ id: "m1", text: "¿y el anticipo?", receivedAt: Date.now() - HORA }] });

    expect(await agent.resumeAfterRelease()).toEqual({ responde: false, motivo: "bot_pausado" });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });
});

describe("processBuffer: hallazgos de la auditoría del 1-nov", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply: vi.fn(async () => {}) } as any);
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult("Claro."));
  });

  it("si al responder lo pendiente el dueño ya contestó, no responde encima", async () => {
    const { agent } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "¿y el anticipo?" },
      { role: "owner", content: "va en dos partes" },
    ] as any);
    agent.state.pendingMessages = [{ text: "¿y el anticipo?", receivedAt: Date.now(), persistedId: "m1" }];

    await agent.processBuffer();

    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("una nota interna al final del historial no se manda como si fuera el cliente", async () => {
    const { agent } = makeAgent();
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "¿y el anticipo?" },
      { role: "note", content: "dile que sí en dos partes" },
    ] as any);
    agent.state.pendingMessages = [{ text: "¿y el anticipo?", receivedAt: Date.now(), persistedId: "m1" }];

    await agent.processBuffer();

    const mensajes = streamTextMock.mock.calls[0][0].messages;
    expect(mensajes[mensajes.length - 1]).toEqual({ role: "user", content: "¿y el anticipo?" });
    expect(JSON.stringify(mensajes)).toContain("Nota interna");
  });

  it("en el canal interno del equipo no hay bloque <relevo>", async () => {
    const { agent, env } = makeAgent();
    env.INTERNAL_CHANNEL = "whatsapp";
    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: "hola" }] as any);
    agent.state.relevoAt = Date.now();
    agent.state.pendingMessages = [{ text: "hola", receivedAt: Date.now() }];

    await agent.processBuffer();

    expect(JSON.stringify(streamTextMock.mock.calls[0][0].system)).not.toContain("<relevo>");
  });
});
