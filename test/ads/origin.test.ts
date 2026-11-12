import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { extractAdReferral, AdOriginsRepo, recordAdOrigin, __resetAdOriginsEnsured } from "../../src/ads/origin";
import { parseYCloudEvent } from "../../src/channels/ycloud";
import { exportLeadToOdoo } from "../../src/tools/leadExport";

describe("extractAdReferral", () => {
  it("lee el estilo de Meta (snake_case)", () => {
    expect(extractAdReferral({ source_url: "https://fb.me/x", source_id: "123", source_type: "ad", headline: "Diagnóstico gratis", ctwa_clid: "ARAkLkA" }))
      .toEqual({ ctwaClid: "ARAkLkA", sourceId: "123", sourceType: "ad", sourceUrl: "https://fb.me/x", headline: "Diagnóstico gratis" });
  });
  it("lee el estilo camelCase", () => {
    expect(extractAdReferral({ sourceId: 987, sourceType: "post", ctwaClid: "c1" })).toMatchObject({ sourceId: "987", ctwaClid: "c1", sourceType: "post" });
  });
  it("null si no trae clic ni anuncio", () => {
    expect(extractAdReferral({ headline: "x" })).toBeNull();
    expect(extractAdReferral(undefined)).toBeNull();
    expect(extractAdReferral("x")).toBeNull();
  });
  it("descarta una URL que no sea http y recorta textos largos", () => {
    const r = extractAdReferral({ ctwa_clid: "c".repeat(300), source_url: "javascript:x", headline: "h".repeat(500) })!;
    expect(r.sourceUrl).toBeNull();
    expect(r.ctwaClid).toHaveLength(128);
    expect(r.headline).toHaveLength(200);
  });
});

describe("AdOriginsRepo", () => {
  let d1: any;
  beforeEach(async () => {
    __resetAdOriginsEnsured();
    const mf = await createTestMiniflare();
    d1 = await mf.getD1Database("DB");
  });

  it("guarda el primer origen y no lo pisa con el segundo", async () => {
    const repo = new AdOriginsRepo(new Db(d1));
    await repo.recordFirst("whatsapp:521", "whatsapp", { ctwaClid: "uno", sourceId: "1", sourceType: "ad", sourceUrl: null, headline: null }, 10);
    await repo.recordFirst("whatsapp:521", "whatsapp", { ctwaClid: "dos", sourceId: "2", sourceType: "ad", sourceUrl: null, headline: null }, 20);
    const r = await repo.get("whatsapp:521");
    expect(r).toMatchObject({ ctwaClid: "uno", sourceId: "1", first_seen_at: 10 });
    expect(await repo.get("whatsapp:999")).toBeNull();
  });

  it("recordAdOrigin no hace nada sin referral y nunca lanza", async () => {
    await recordAdOrigin(d1, "whatsapp:1", "whatsapp", undefined);
    expect(await new AdOriginsRepo(new Db(d1)).get("whatsapp:1")).toBeNull();
    const roto = { prepare: () => { throw new Error("D1 caído"); } } as any;
    __resetAdOriginsEnsured();
    await expect(recordAdOrigin(roto, "whatsapp:1", "whatsapp", { ctwaClid: "x", sourceId: null, sourceType: null, sourceUrl: null, headline: null })).resolves.toBeUndefined();
  });
});

describe("parseYCloudEvent con referral", () => {
  it("adjunta el origen del anuncio al mensaje", async () => {
    const msg = await parseYCloudEvent({
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: { from: "+5214441234567", id: "wamid.1", type: "text", text: { body: "Hola, vi su anuncio" }, referral: { ctwa_clid: "clid-1", source_id: "ad-9", source_type: "ad" } },
    }, {} as any, "https://x");
    expect(msg?.adReferral).toMatchObject({ ctwaClid: "clid-1", sourceId: "ad-9" });
  });
  it("un mensaje normal no trae origen", async () => {
    const msg = await parseYCloudEvent({
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: { from: "+5214441234567", id: "wamid.2", type: "text", text: { body: "Hola" } },
    }, {} as any, "https://x");
    expect(msg?.adReferral).toBeUndefined();
  });
});

describe("exportLeadToOdoo con origen", () => {
  it("manda adOrigin solo cuando existe", async () => {
    const f = vi.fn(async (_u: any, _i: any) => new Response(JSON.stringify({ ok: true, odoo_lead_id: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const env = { LEAD_EXPORT_WEBHOOK_URL: "https://n8n.x/hook" } as any;
    await exportLeadToOdoo(env, { leadId: "l1", conversationId: "c", intent: "x", channel: "whatsapp", adOrigin: { ctwaClid: "k", sourceId: "1", sourceType: "ad", headline: null } });
    await exportLeadToOdoo(env, { leadId: "l2", conversationId: "c", intent: "x", channel: "whatsapp" });
    expect(JSON.parse((f.mock.calls[0][1] as any).body).adOrigin).toMatchObject({ ctwaClid: "k" });
    expect(JSON.parse((f.mock.calls[1][1] as any).body)).not.toHaveProperty("adOrigin");
    vi.unstubAllGlobals();
  });
});
