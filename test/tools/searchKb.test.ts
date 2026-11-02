import { describe, it, expect, vi } from "vitest";
import { searchKbTool } from "../../src/tools/searchKb";

describe("searchKbTool", () => {
  it("returns top-k chunks with scores", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      KB: { query: vi.fn(async () => ({ matches: [
        { id: "c1", score: 0.91, metadata: { title: "Embebar wall", content: "Pega <div data-tv-wall>...</div>" } },
        { id: "c2", score: 0.78, metadata: { title: "Generar carrusel", content: "Ir a Distribuir..." } },
      ] })) },
    } as any;
    const tool = searchKbTool(fakeEnv);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    const result = await execute({ query: "como embebo wall" });
    expect(result.results).toHaveLength(2);
    expect(result.results[0].title).toBe("Embebar wall");
    expect(result.results[0].score).toBe(0.91);
  });

  it("pide el metadata completo a Vectorize: por defecto es \"none\" y sin él no vuelve ni título ni texto", async () => {
    const query = vi.fn(async () => ({ matches: [{ id: "c1", score: 0.9, metadata: { title: "T", content: "C" } }] }));
    const fakeEnv = { AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) }, KB: { query } } as any;
    const tool = searchKbTool(fakeEnv);
    await (tool.execute as (input: { query: string }) => Promise<any>)({ query: "precio" });
    expect(query).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({ topK: 5, returnMetadata: "all" }));
  });

  it("returns empty results when KB throws", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) },
      KB: { query: vi.fn(async () => { throw new Error("boom"); }) },
    } as any;
    const tool = searchKbTool(fakeEnv);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    const result = await execute({ query: "x" });
    expect(result.error).toBe("transient");
  });

  it("llama a onResult con los resultados cuando la búsqueda tiene éxito", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      KB: { query: vi.fn(async () => ({ matches: [
        { id: "c1", score: 0.91, metadata: { title: "Precios", content: "Corte: $150" } },
      ] })) },
    } as any;
    const onResult = vi.fn();
    const tool = searchKbTool(fakeEnv, onResult);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    await execute({ query: "precio" });

    expect(onResult).toHaveBeenCalledTimes(1);
    const [results] = onResult.mock.calls[0];
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Precios");
  });

  it("NO llama a onResult cuando la búsqueda falla", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) },
      KB: { query: vi.fn(async () => { throw new Error("boom"); }) },
    } as any;
    const onResult = vi.fn();
    const tool = searchKbTool(fakeEnv, onResult);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    await execute({ query: "x" });

    expect(onResult).not.toHaveBeenCalled();
  });
});
