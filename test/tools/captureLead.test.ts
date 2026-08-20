import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { LeadsRepo } from "../../src/db/leads";
import { captureLeadTool } from "../../src/tools/captureLead";

let env: any;
let leads: LeadsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  leads = new LeadsRepo(db);
  // The leads table FKs conversation_id -> conversations(id), so we need a real
  // conversation row before the tool can attach a lead to it (same pattern as
  // the green handoffHuman/pauseBot tool tests).
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = { DB: d1, BOT_TIER: "pro" };
});

afterEach(() => vi.restoreAllMocks());

describe("captureLeadTool", () => {
  it("creates lead in D1 even without external service", async () => {
    const tool = captureLeadTool(env, () => convId, () => "telegram");
    // AI SDK v6: tool.execute is optional + expects (input, options). Invoke with
    // 2 args and cast the result (same pattern as the repo's green tool tests).
    const result = (await tool.execute!(
      {
        name: "María",
        contact: "+5215512345",
        intent: "Corte + barba 5pm",
      },
      {} as any,
    )) as { leadId: string; message: string };
    expect(result.leadId).toBeTruthy();
    const list = await leads.list(10);
    expect(list).toHaveLength(1);
    expect(list[0].intent).toBe("Corte + barba 5pm");
  });

  it("no llama al webhook si LEAD_EXPORT_WEBHOOK_URL no está configurado", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = captureLeadTool(env, () => convId, () => "telegram");
    await tool.execute!({ intent: "Cotización sitio web" }, {} as any);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exporta el lead a Odoo (vía n8n) cuando LEAD_EXPORT_WEBHOOK_URL está configurado, separando email/phone/otherContact", async () => {
    // { ok: true, odoo_lead_id: N } es la respuesta real del workflow
    // BIRevX_Forja_Lead_to_Odoo (nodo "Responder OK" en n8n).
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, odoo_lead_id: 4321 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = {
      ...env,
      LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo",
      BOT_NAME: "BIRevX Support Bot",
    };
    const tool = captureLeadTool(withExport, () => convId, () => "telegram");
    const result = (await tool.execute!(
      { name: "María", contact: "+5215512345", intent: "Corte + barba 5pm", notes: "prefiere tarde" },
      {} as any,
    )) as { leadId: string; message: string };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://n8n.birevx.com/webhook/forja-lead-to-odoo");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      leadId: result.leadId,
      conversationId: convId,
      name: "María",
      phone: "5215512345",
      intent: "Corte + barba 5pm",
      notes: "prefiere tarde",
      // getChannel real gana sobre BOT_NAME.
      channel: "telegram",
    });
  });

  it("usa BOT_NAME como fallback de channel si getChannel no devuelve nada", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, odoo_lead_id: 1 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = {
      ...env,
      LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo",
      BOT_NAME: "BIRevX Support Bot",
    };
    const tool = captureLeadTool(withExport, () => convId, () => null);
    await tool.execute!({ intent: "Diagnóstico inicial" }, {} as any);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).channel).toBe("BIRevX Support Bot");
  });

  it("el caso real que rompió producción: '4447029227 / manuel_pl3@hotmail.com' separa teléfono y email sin corromper el teléfono con dígitos del correo", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, odoo_lead_id: 999 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId, () => "whatsapp");

    await tool.execute!(
      { contact: "4447029227 / manuel_pl3@hotmail.com", intent: "Cotización" },
      {} as any,
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.phone).toBe("4447029227");
    expect(body.email).toBe("manuel_pl3@hotmail.com");
  });

  it("alias de Instagram junto a teléfono: se captura en otherContact sin perderse ni forzarse a phone", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, odoo_lead_id: 1 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId, () => "instagram");

    await tool.execute!(
      { contact: "@mi_negocio_ig, tel 5551234567", intent: "Consulta" },
      {} as any,
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.phone).toBe("5551234567");
    expect(body.otherContact).toContain("@mi_negocio_ig");
  });

  it("registra el odoo_lead_id devuelto con setExported", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, odoo_lead_id: 4321 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId, () => "telegram");

    const result = (await tool.execute!({ intent: "Diagnóstico inicial" }, {} as any)) as { leadId: string };

    const list = await leads.list(10);
    expect(list[0].id).toBe(result.leadId);
    expect(list[0].exported_to).toBe("odoo");
    expect(list[0].external_id).toBe("4321");
  });

  it("si la respuesta del webhook no es JSON válido, no truena y no marca como exportado", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId, () => "telegram");

    const result = (await tool.execute!({ intent: "Diagnóstico inicial" }, {} as any)) as { leadId: string };

    const list = await leads.list(10);
    expect(list[0].id).toBe(result.leadId);
    expect(list[0].exported_to).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("si el webhook de export falla, el lead igual queda guardado y la tool no truena", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId, () => "telegram");

    const result = (await tool.execute!(
      { intent: "Diagnóstico inicial" },
      {} as any,
    )) as { leadId: string; message: string };

    expect(result.leadId).toBeTruthy();
    expect(result.message).toBe("Lead capturado.");
    const list = await leads.list(10);
    expect(list).toHaveLength(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[leadExport] export a Odoo falló:",
      expect.any(Error),
    );
  });

  it("el fetch de export tiene un timeout acotado (~3s) — un webhook lento ya NO cuelga indefinidamente la respuesta", async () => {
    // Comportamiento ANTERIOR (documentado en versiones previas de este test):
    // el fetch iba dentro de un `await` sin timeout, así que un webhook lento
    // agregaba latencia ILIMITADA a la respuesta del tool. Con
    // AbortSignal.timeout(3000) en exportLeadToOdoo, ahora la latencia máxima
    // que puede añadir el webhook está acotada por ese timeout: un fetch que
    // nunca resuelve se aborta solo y el tool responde igual, sin colgarse.
    // El mock nunca resuelve por sí solo — pero, igual que el fetch real,
    // SÍ escucha `signal` y rechaza cuando AbortSignal.timeout(3000) dispara.
    // Sin esto el mock colgaría para siempre sin importar el timeout real.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const withExport = { ...env, LEAD_EXPORT_WEBHOOK_URL: "https://n8n.birevx.com/webhook/forja-lead-to-odoo" };
    const tool = captureLeadTool(withExport, () => convId, () => "telegram");

    // AbortSignal.timeout corre en tiempo real (no responde a fake timers de
    // vitest de forma confiable aquí), así que verificamos con un timeout de
    // test generoso (>3s) que la promesa SÍ se resuelve, en vez de colgarse.
    const result = (await tool.execute!({ intent: "Cotización" }, {} as any)) as { leadId: string };
    expect(result.leadId).toBeTruthy();
    expect(consoleErrorSpy).toHaveBeenCalled();
  }, 8000);
});
