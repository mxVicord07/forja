import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { LeadsRepo } from "../../src/db/leads";
import { respaldoSemanal, tocaRespaldo, claveRespaldo, filtrarSensibles, CONSERVAR } from "../../src/crons/respaldoSemanal";

// R2 en memoria: lo justo para put / list / delete.
function r2() {
  const objs = new Map<string, { body: ArrayBuffer; meta: any }>();
  return {
    objs,
    async put(key: string, body: ArrayBuffer, meta: any) { objs.set(key, { body, meta }); },
    async list({ prefix }: { prefix: string }) { return { objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key: string) { objs.delete(key); },
  };
}

async function gunzipJson(buf: ArrayBuffer): Promise<any> {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(s).text());
}

let env: any;
let media: ReturnType<typeof r2>;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  media = r2();
  env = { DB: d1, MEDIA: media, BOT_NAME: "Bot Prueba", FEATURE_RESPALDO_SEMANAL: "1" };
  const db = new Db(d1 as any);
  await new LeadsRepo(db).create({ conversationId: null, name: "Ana", contact: "ana@x.com", channelUserId: null, intent: "cotizar" });
  await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('llm_api_key', 'sk-secreto', 1), ('tone', 'cercano', 1)");
});

describe("respaldoSemanal", () => {
  it("apagado por omisión o sin bucket", async () => {
    expect(await respaldoSemanal({ ...env, FEATURE_RESPALDO_SEMANAL: undefined })).toEqual({ hecho: false, motivo: "apagado" });
    expect(await respaldoSemanal({ ...env, MEDIA: undefined })).toEqual({ hecho: false, motivo: "apagado" });
    expect(media.objs.size).toBe(0);
  });

  it("guarda las tablas en gzip y nunca guarda llaves", async () => {
    const now = new Date("2026-11-15T03:00:00Z");
    const r = await respaldoSemanal(env, now);
    expect(r.hecho).toBe(true);
    expect(r.clave).toBe("respaldos/2026-11-15.json.gz");
    const data = await gunzipJson(media.objs.get(r.clave!)!.body);
    expect(data.bot).toBe("Bot Prueba");
    expect(data.tablas.leads.filas[0].name).toBe("Ana");
    const keys = data.tablas.settings.filas.map((f: any) => f.key);
    expect(keys).toContain("tone");
    expect(keys).not.toContain("llm_api_key");
    expect(JSON.stringify(data)).not.toContain("sk-secreto");
    expect(data.tablas.settings_history).toBeUndefined();
    expect(data.tablas.magic_links).toBeUndefined();
  });

  it(`conserva solo los ${CONSERVAR} más recientes`, async () => {
    for (let i = 1; i <= 10; i++) await media.put(`respaldos/2026-09-${String(i).padStart(2, "0")}.json.gz`, new ArrayBuffer(1), {});
    await media.put("respaldos/notas.txt", new ArrayBuffer(1), {});
    const r = await respaldoSemanal(env, new Date("2026-11-15T03:00:00Z"));
    const quedan = [...media.objs.keys()].filter((k) => k.endsWith(".json.gz")).sort();
    expect(quedan).toHaveLength(CONSERVAR);
    expect(quedan.at(-1)).toBe("respaldos/2026-11-15.json.gz");
    expect(r.borrados).toContain("respaldos/2026-09-01.json.gz");
    expect(media.objs.has("respaldos/notas.txt")).toBe(true); // no toca lo que no es un respaldo
  });
});

describe("utilidades", () => {
  it("toca los domingos UTC", () => {
    expect(tocaRespaldo(new Date("2026-11-15T03:00:00Z"))).toBe(true);
    expect(tocaRespaldo(new Date("2026-11-16T03:00:00Z"))).toBe(false);
  });
  it("clave por fecha", () => {
    expect(claveRespaldo(new Date("2026-11-15T03:00:00Z"))).toBe("respaldos/2026-11-15.json.gz");
  });
  it("filtra ajustes con nombre de secreto solo en settings", () => {
    const filas = [{ key: "llm_api_key" }, { key: "webhook_token" }, { key: "dashboard_password" }, { key: "tone" }];
    expect(filtrarSensibles("settings", filas).map((f) => f.key)).toEqual(["tone"]);
    expect(filtrarSensibles("leads", filas)).toHaveLength(4);
  });
});
