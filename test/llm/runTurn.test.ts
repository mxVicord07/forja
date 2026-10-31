import { describe, it, expect, vi, beforeEach } from "vitest";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import { runLlmTurn } from "../../src/llm/runTurn";

function streamOk(text: string) {
  async function* gen() {
    yield text;
  }
  return {
    textStream: gen(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 }),
    steps: Promise.resolve([{ toolCalls: [] }]),
  };
}

const ARGS = {
  model: { id: "gpt-4o" },
  system: [{ role: "system" as const, content: "hola" }],
  messages: [{ role: "user" as const, content: "hola" }],
  tools: { searchKb: {} },
  stopWhen: ({ steps }: { steps: any[] }) => steps.length >= 6,
};

describe("runLlmTurn", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
  });

  it("con herramientas, devuelve solo el texto del último paso (no la narración previa)", async () => {
    // Hallazgo real 30-oct-2026 (chat del sitio): el cliente vio
    // "Déjame consultar…La búsqueda me dio poco, así que…" porque el stream
    // junta el texto de todos los pasos, incluido el de antes de searchKb.
    async function* gen() {
      yield "Déjame consultar qué opciones tenemos.";
      yield "Te cuento: diseñamos CRM y ERP a la medida.";
    }
    streamTextMock.mockImplementation(() => ({
      textStream: gen(),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 }),
      steps: Promise.resolve([
        { text: "Déjame consultar qué opciones tenemos.", toolCalls: [{ toolName: "searchKb", input: {} }] },
        { text: "Te cuento: diseñamos CRM y ERP a la medida.", toolCalls: [] },
      ]),
    }));
    const r = await runLlmTurn(ARGS);
    expect(r.text).toBe("Te cuento: diseñamos CRM y ERP a la medida.");
    expect(r.toolCallCount).toBe(1);
  });

  it("si el último paso no trae texto, conserva lo acumulado", async () => {
    async function* gen() { yield "Listo, quedó tu cita."; }
    streamTextMock.mockImplementation(() => ({
      textStream: gen(),
      usage: Promise.resolve({}),
      steps: Promise.resolve([
        { text: "Listo, quedó tu cita.", toolCalls: [{ toolName: "scheduleAppointment", input: {} }] },
        { text: "", toolCalls: [] },
      ]),
    }));
    expect((await runLlmTurn(ARGS)).text).toBe("Listo, quedó tu cita.");
  });

  it("usa streamText cuando el stream produce texto", async () => {
    streamTextMock.mockImplementation(() => streamOk("buen día"));
    const r = await runLlmTurn(ARGS);
    expect(r.text).toBe("buen día");
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(streamTextMock.mock.calls[0][0].tools).toEqual({ searchKb: {} });
  });

  it("si streamText da 400 / NoOutput, reintenta con generateText (sin SSE)", async () => {
    const streamErr = Object.assign(new Error("No output generated. Check the stream for errors."), {
      name: "AI_NoOutputGeneratedError",
      cause: Object.assign(new Error("Bad Request"), {
        name: "AI_APICallError",
        statusCode: 400,
        url: "https://api.openai.com/v1/responses",
        responseBody: '{"error":{"message":"Invalid schema"}}',
      }),
    });
    streamTextMock.mockImplementation(() => {
      throw streamErr;
    });
    generateTextMock.mockResolvedValue({
      text: "hola, ¿en qué te ayudo?",
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 0 },
      steps: [{ toolCalls: [{ toolName: "searchKb", input: { query: "hola" } }] }],
    });

    const r = await runLlmTurn(ARGS);
    expect(r.text).toBe("hola, ¿en qué te ayudo?");
    expect(r.toolCallCount).toBe(1);
    expect(r.toolCallsMade).toEqual([{ toolName: "searchKb", input: { query: "hola" } }]);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][0].messages).toEqual(ARGS.messages);
  });

  it("no usa generateText en un 429 — eso es failover de proveedor", async () => {
    streamTextMock.mockImplementation(() => {
      throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    });
    await expect(runLlmTurn(ARGS)).rejects.toThrow(/Too Many Requests/);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
