import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { AppointmentsRepo } from "../../src/db/appointments";
import { runCitaRecordatorios, recordatorioActivo, textoRecordatorio, __resetCitaRecordatoriosEnsured } from "../../src/followup/citaRecordatorio";

const NOW = Date.parse("2026-11-16T15:00:00Z");
const H = 3_600_000;
let env: any; let db: Db; let fetchMock: any;

async function seed(conv: string, canal: string, user: string, startMs: number, lastUserMs: number | null) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?, ?, ?, ?, ?)", [conv, canal, user, NOW - 5 * 24 * H, NOW]);
  if (lastUserMs != null) await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'hola', ?)", [crypto.randomUUID(), conv, lastUserMs]);
  return new AppointmentsRepo(db).create({ conversationId: conv, calcomUid: "u-" + conv, eventTypeId: 1, start: new Date(startMs).toISOString(), attendeeName: "Ana Pérez", attendeeEmail: "ana@x.com" });
}

beforeEach(async () => {
  __resetCitaRecordatoriosEnsured();
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  env = { DB: d1, BOT_TIER: "pro", BUSINESS_NAME: "Barbería Fénix", FEATURE_RECORDATORIO_CITA: "1", WA_PROVIDER: "ycloud", YCLOUD_API_KEY: "k", YCLOUD_WA_FROM: "+5210000000000", CITA_RECORDATORIO_PLANTILLA: "cita_recordatorio_v1" };
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "msg1", status: "accepted" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("recordatorioActivo", () => {
  it("apagado por omisión, sin agenda o con CRM conectado", () => {
    expect(recordatorioActivo({ BOT_TIER: "pro" } as any).motivo).toBe("apagado");
    expect(recordatorioActivo({ BOT_TIER: "free", FEATURE_RECORDATORIO_CITA: "1" } as any).motivo).toBe("sin_agenda");
    expect(recordatorioActivo({ BOT_TIER: "pro", FEATURE_RECORDATORIO_CITA: "1", CRM_AGENDA_URL: "https://x" } as any).motivo).toBe("lo_manda_el_crm");
    expect(recordatorioActivo({ BOT_TIER: "pro", FEATURE_RECORDATORIO_CITA: "1" } as any).activo).toBe(true);
  });
});

describe("runCitaRecordatorios", () => {
  it("fuera de la ventana de 24 h manda la plantilla con nombre, día y hora, una sola vez", async () => {
    await seed("whatsapp:5214441112233", "whatsapp", "5214441112233", NOW + 20 * H, NOW - 3 * 24 * H);
    const r = await runCitaRecordatorios(env, NOW);
    expect(r).toMatchObject({ enviados: 1, fallidos: 0 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("cita_recordatorio_v1");
    expect(body.to).toBe("+5214441112233");
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(["Ana", "martes, 17 de noviembre", "05:00"]);
    expect((await runCitaRecordatorios(env, NOW + H)).enviados).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dentro de la ventana manda texto libre, no plantilla", async () => {
    await seed("whatsapp:5214441112233", "whatsapp", "5214441112233", NOW + 5 * H, NOW - 2 * H);
    expect((await runCitaRecordatorios(env, NOW)).enviados).toBe(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe("text");
    expect(body.text.body).toContain("te recordamos tu cita con Barbería Fénix");
  });

  it("sin plantilla y fuera de ventana se salta sin quemar el candado", async () => {
    await seed("whatsapp:5214441112233", "whatsapp", "5214441112233", NOW + 20 * H, null);
    const r = await runCitaRecordatorios({ ...env, CITA_RECORDATORIO_PLANTILLA: "" }, NOW);
    expect(r).toMatchObject({ enviados: 0, saltados: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await runCitaRecordatorios(env, NOW)).enviados).toBe(1); // con plantilla, sí sale
  });

  it("si YCloud rechaza, suelta el candado para reintentar", async () => {
    await seed("whatsapp:5214441112233", "whatsapp", "5214441112233", NOW + 20 * H, null);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    expect(await runCitaRecordatorios(env, NOW)).toMatchObject({ enviados: 0, fallidos: 1 });
    vi.stubGlobal("fetch", fetchMock);
    expect((await runCitaRecordatorios(env, NOW + H)).enviados).toBe(1);
  });

  it("no recuerda citas canceladas, pasadas, a menos de 2 h ni a más de 24 h", async () => {
    await seed("whatsapp:1", "whatsapp", "5211", NOW + 1 * H, null);
    await seed("whatsapp:2", "whatsapp", "5212", NOW + 30 * H, null);
    await seed("whatsapp:3", "whatsapp", "5213", NOW - 2 * H, null);
    const id = await seed("whatsapp:4", "whatsapp", "5214", NOW + 10 * H, null);
    await new AppointmentsRepo(db).markCancelled(id);
    expect(await runCitaRecordatorios(env, NOW)).toMatchObject({ enviados: 0, saltados: 0 });
  });

  it("una cita movida recibe su recordatorio nuevo", async () => {
    const id = await seed("whatsapp:5214441112233", "whatsapp", "5214441112233", NOW + 20 * H, null);
    await runCitaRecordatorios(env, NOW);
    await new AppointmentsRepo(db).confirmAfterReschedule(id, "u-nuevo", new Date(NOW + 22 * H).toISOString());
    expect((await runCitaRecordatorios(env, NOW + H)).enviados).toBe(1);
  });

  it("con CRM conectado no manda nada", async () => {
    await seed("whatsapp:5214441112233", "whatsapp", "5214441112233", NOW + 20 * H, null);
    expect(await runCitaRecordatorios({ ...env, CRM_AGENDA_URL: "https://n8n/x" }, NOW)).toMatchObject({ enviados: 0, motivo: "lo_manda_el_crm" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("textoRecordatorio", () => {
  it("usa el nombre de pila y funciona sin nombre", () => {
    expect(textoRecordatorio("Ana Pérez", "martes", "10:00", "X")).toContain("Hola Ana, ");
    expect(textoRecordatorio("", "martes", "10:00", "X")).toContain("Hola, te recordamos");
  });
});
