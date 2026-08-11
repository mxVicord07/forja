import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { normalizeForSpam, isRepeatSpam, isOverDailyCap, DAILY_TURN_CAP, DAILY_CAP_MESSAGE } from "../src/spam";

let db: Db;
let convId: string;

async function addUserMsg(content: string, createdAt: number) {
  await db.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
    [crypto.randomUUID(), convId, content, createdAt],
  );
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "spam-test");
  convId = conv.id;
});

describe("normalizeForSpam", () => {
  it("quita acentos, espacios extra y mayúsculas", () => {
    expect(normalizeForSpam("  ¿CUÁNTO   Cuesta? ")).toBe("¿cuanto cuesta?");
    expect(normalizeForSpam("Órale\n\nsí")).toBe("orale si");
  });
});

describe("isRepeatSpam", () => {
  const NOW = 1_800_000_000_000;

  it("mismo mensaje por 3ª vez entre los últimos 5 → spam", async () => {
    await addUserMsg("compra mi curso ya", NOW - 3000);
    await addUserMsg("hola", NOW - 2000);
    await addUserMsg("COMPRA MI CURSO YA", NOW - 1000);
    expect(await isRepeatSpam(db, convId, "compra mi curso ya!", NOW)).toBe(false); // "!" lo hace distinto
    expect(await isRepeatSpam(db, convId, "Compra mi curso ya", NOW)).toBe(true);
  });

  it("una repetición aislada no es spam", async () => {
    await addUserMsg("¿cuánto cuesta?", NOW - 1000);
    expect(await isRepeatSpam(db, convId, "¿cuánto cuesta?", NOW)).toBe(false);
  });

  it("solo mira los últimos 5 mensajes", async () => {
    await addUserMsg("promo", NOW - 6000);
    await addUserMsg("promo", NOW - 5000);
    for (let i = 0; i < 5; i++) await addUserMsg(`otro ${i}`, NOW - 4000 + i);
    expect(await isRepeatSpam(db, convId, "promo", NOW)).toBe(false);
  });

  it("mensajes ultracortos no cuentan", async () => {
    await addUserMsg("k", NOW - 2000);
    await addUserMsg("k", NOW - 1000);
    expect(await isRepeatSpam(db, convId, "k", NOW)).toBe(false);
  });

  it("una despedida repetida a lo largo de DÍAS distintos no es spam (incidente 2026-08-11)", async () => {
    await addUserMsg("Gracias", NOW - 4 * 24 * 3600_000);
    await addUserMsg("Gracias!", NOW - 3 * 24 * 3600_000);
    await addUserMsg("Gracias", NOW - 2 * 24 * 3600_000);
    await addUserMsg("Gracias!", NOW - 1 * 24 * 3600_000);
    expect(await isRepeatSpam(db, convId, "gracias", NOW)).toBe(false);
  });

  it("flood real — 2 repeticiones en minutos SÍ es spam", async () => {
    await addUserMsg("compra mi curso ya", NOW - 5 * 60_000);
    await addUserMsg("compra mi curso ya", NOW - 2 * 60_000);
    expect(await isRepeatSpam(db, convId, "compra mi curso ya", NOW)).toBe(true);
  });
});

describe("isOverDailyCap (backstop ChatGPT gratis)", () => {
  const NOW = 1_800_000_000_000;

  it("bajo el tope no pasa nada, al llegar al tope se activa", async () => {
    for (let i = 0; i < DAILY_TURN_CAP - 1; i++) {
      await addUserMsg(`pregunta ${i}`, NOW - i * 60_000);
    }
    expect(await isOverDailyCap(db, convId, NOW)).toBe(false);

    await addUserMsg("una mas", NOW - 1000);
    expect(await isOverDailyCap(db, convId, NOW)).toBe(true);
  });

  it("solo cuenta las últimas 24h y solo mensajes de usuario", async () => {
    // 50 turnos pero de hace 2 días → no cuenta.
    for (let i = 0; i < DAILY_TURN_CAP; i++) {
      await addUserMsg(`vieja ${i}`, NOW - 48 * 3600_000 - i * 1000);
    }
    expect(await isOverDailyCap(db, convId, NOW)).toBe(false);

    // Mensajes del bot no cuentan para el tope.
    for (let i = 0; i < DAILY_TURN_CAP; i++) {
      await db.run(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`,
        [crypto.randomUUID(), convId, `respuesta ${i}`, NOW - i * 1000],
      );
    }
    expect(await isOverDailyCap(db, convId, NOW)).toBe(false);
  });

  it("la despedida es amable, genérica y sin em/en-dashes", () => {
    expect(DAILY_CAP_MESSAGE.length).toBeGreaterThan(0);
    expect(DAILY_CAP_MESSAGE).not.toMatch(/[—–]/);
  });
});
