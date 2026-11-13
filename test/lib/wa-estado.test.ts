import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { leerFallo, anotarFallo, estadoVentana, horasEntradaGratis, __resetWaEstado } from "../../src/lib/wa-estado";
import { AdOriginsRepo, __resetAdOriginsEnsured } from "../../src/ads/origin";
import { renderThreadLive } from "../../src/admin/views/conversations";

const H = 3_600_000;
const evento = (o: Record<string, unknown> = {}) => ({
  type: "whatsapp.message.updated",
  whatsappMessage: { id: "yc1", to: "+524441796793", status: "failed", errorCode: "131047", errorMessage: "Message failed to send because more than 24 hours…", text: { body: "Hola Victor, soy Víctor de BIRevX. Paso breve dando un seguimiento." }, updateTime: "2026-11-13T17:03:32.163Z", ...o },
});

let d1: D1Database;
let db: Db;
beforeEach(async () => {
  __resetWaEstado();
  __resetAdOriginsEnsured();
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  db = new Db(d1);
});
async function conv(id: string, tel: string) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?, 'whatsapp', ?, 'Victor', ?, ?)", [id, tel, Date.now(), Date.now()]);
}
const msg = (cid: string, role: string, t: number, content = "x") =>
  db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)", [crypto.randomUUID(), cid, role, content, t]);

describe("leerFallo", () => {
  it("solo toma los mensajes fallidos y traduce el código", () => {
    const f = leerFallo(evento())!;
    expect(f.codigo).toBe("131047");
    expect(f.motivo).toContain("24 h");
    expect(f.texto).toContain("Hola Victor");
    expect(leerFallo(evento({ status: "delivered" }))).toBeNull();
    expect(leerFallo({ type: "whatsapp.inbound_message.received" })).toBeNull();
    expect(leerFallo(evento({ errorCode: "999", errorMessage: "raro" }))!.motivo).toBe("raro");
  });
});

describe("anotarFallo", () => {
  it("deja una nota en el hilo del contacto (con o sin el 1 de México) y no la repite si YCloud reintenta", async () => {
    await conv("whatsapp:5214441796793", "5214441796793");
    expect(await anotarFallo(d1, leerFallo(evento())!)).toBe("anotado");
    expect(await anotarFallo(d1, leerFallo(evento())!)).toBe("repetido");
    const notas = await db.all<{ role: string; content: string }>("SELECT role, content FROM messages WHERE conversation_id = ?", ["whatsapp:5214441796793"]);
    expect(notas).toHaveLength(1);
    expect(notas[0].role).toBe("note");
    expect(notas[0].content).toMatch(/^⚠️ WhatsApp no entregó un mensaje \(«Hola Victor/);
    expect(notas[0].content).toContain("código 131047");
  });
  it("sin conversación conocida no truena", async () => {
    expect(await anotarFallo(d1, leerFallo(evento({ id: "yc2", to: "+5215550000000" }))!)).toBe("sin_conversacion");
  });
});

describe("estadoVentana", () => {
  const ahora = Date.parse("2026-11-13T18:00:00Z");
  it("sin anuncio: solo la ventana de 24 h", async () => {
    await conv("c1", "524441112233");
    await msg("c1", "user", ahora - 2 * H);
    const e = (await estadoVentana(db, { id: "c1", channel: "whatsapp", channel_user_id: "524441112233" }, {}, ahora))!;
    expect(e.ventana.state).toBe("open");
    expect(e.gratisHasta).toBeNull();
  });
  it("lead de anuncio respondido en menos de 24 h: plantillas gratis 72 h (o lo configurado) aunque el texto libre ya cerró", async () => {
    await conv("c2", "524441112244");
    await new AdOriginsRepo(db).recordFirst("c2", "whatsapp", { ctwaClid: "clid", sourceId: "1", sourceType: "ad", sourceUrl: null, headline: null }, ahora - 40 * H);
    await msg("c2", "user", ahora - 40 * H);
    await msg("c2", "assistant", ahora - 39 * H);
    const c = { id: "c2", channel: "whatsapp", channel_user_id: "524441112244" };
    const e = (await estadoVentana(db, c, {}, ahora))!;
    expect(e.ventana.state).toBe("closed");
    expect(e.gratisHasta).toBe(ahora - 39 * H + 72 * H);
    expect((await estadoVentana(db, c, { WA_ENTRADA_GRATIS_HORAS: "168" }, ahora))!.gratisHasta).toBe(ahora - 39 * H + 168 * H);
    expect((await estadoVentana(db, c, {}, ahora + 40 * H))!.gratisHasta).toBeNull();
  });
  it("canales sin ventana (web, Telegram) no muestran nada", async () => {
    expect(await estadoVentana(db, { id: "x", channel: "telegram", channel_user_id: "1" }, {}, ahora)).toBeNull();
  });
  it("horas fuera de rango vuelven a 72", () => {
    expect(horasEntradaGratis({ WA_ENTRADA_GRATIS_HORAS: "5" })).toBe(72);
    expect(horasEntradaGratis({})).toBe(72);
  });
});

describe("hilo en el panel", () => {
  it("muestra la ventana cerrada en la cabecera y la nota de rechazo con su propio estilo", async () => {
    await conv("whatsapp:524441796793", "524441796793");
    await msg("whatsapp:524441796793", "user", Date.now() - 10 * 24 * H, "hola");
    await anotarFallo(d1, leerFallo(evento({ id: "yc9" }))!);
    const html = await renderThreadLive({ DB: d1 } as any, "whatsapp:524441796793");
    expect(html).toContain("ventana cerrada");
    expect(html).toContain("nota interna");
    expect(html).toContain("WhatsApp no entregó");
  });
});
