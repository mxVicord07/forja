import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { LeadsRepo, leadMetadata } from "../src/db/leads";
import { ALL_NICHES, NICHE_IDS, getNiche, nicheSchedulesAppointments } from "../src/niches";
import { buildTools, type ToolContext } from "../src/tools/index";
import { systemPromptFromEnv } from "../src/system-prompt";
import { layout } from "../src/admin/views/layout";
import { registrarCitaTool } from "../src/tools/servicios";
import { crearReservacionTool, tomarPedidoTool } from "../src/tools/restaurante";
import { registrarPedidoTool } from "../src/tools/comercio";
import type { Env } from "../src/env";

// Giros de Forja+ v1.0.51 portados el 13-nov-2026.
const CITAS = ["barberia", "salon", "spa", "clinica", "dentista", "gimnasio", "coach"];
const PEDIDOS = ["restaurante", "cafeteria", "panaderia", "tienda"];

function ctx(tier: "free" | "negocio" | "pro", niche?: string, over: Record<string, unknown> = {}): ToolContext {
  const env = {
    BOT_TIER: tier,
    BOT_NICHE: niche,
    DB: {} as any,
    AI: {} as any,
    BUSINESS_NAME: "Test",
    BOT_NAME: "Bot",
    BOT_LANGUAGE: "es-MX",
    ...over,
  } as any;
  return { env, getConversationId: () => "conv-1" };
}
const names = (c: ToolContext) => Object.keys(buildTools(c)).sort();

describe("registro de giros", () => {
  it("están los 7 de citas, los 4 de pedidos y el genérico", () => {
    expect([...NICHE_IDS].sort()).toEqual(["generico", ...CITAS, ...PEDIDOS].sort());
  });

  it("cada giro resuelve por BOT_NICHE (con mayúsculas o espacios)", () => {
    for (const id of [...CITAS, ...PEDIDOS]) {
      expect(getNiche(ctx("pro", ` ${id.toUpperCase()} `).env).id).toBe(id);
    }
  });

  it("cada pack trae etiquetas, columnas con texto, tono y playbook (sin claves de diccionario sueltas)", () => {
    for (const n of ALL_NICHES.filter((p) => p.id !== "generico")) {
      expect(n.recordSingular && n.recordPlural && n.navLabel && n.kpiLabel).toBeTruthy();
      for (const s of Object.values(n.statusLabels)) expect(s).toBeTruthy();
      expect(n.columns.length).toBeGreaterThan(0);
      for (const c of n.columns) {
        expect(c.key).toMatch(/^[a-z]+$/);
        expect(c.label).toBeTruthy();
      }
      expect(n.defaultTone).toBeTruthy();
      expect(n.playbook).toContain("<diagnostic_playbooks>");
      expect(JSON.stringify(n)).not.toContain("nicho.");
      // Las tools de agenda de Forja+ no existen en este fork.
      expect(n.playbook).not.toMatch(/agendarCita|verDisponibilidad/);
    }
  });

  it("los 7 de citas agendan por diseño; los de pedidos no", () => {
    for (const id of CITAS) expect(nicheSchedulesAppointments(ctx("pro", id).env)).toBe(true);
    for (const id of [...PEDIDOS, undefined]) expect(nicheSchedulesAppointments(ctx("pro", id).env)).toBe(false);
  });

  it("los giros de citas comparten el bloque de agenda que nombra las tools reales", () => {
    for (const id of CITAS) {
      const p = getNiche(ctx("pro", id).env).playbook;
      expect(p).toContain('<playbook name="agenda">');
      expect(p).toContain("scheduleAppointment");
      expect(p).toContain("registrarCita");
    }
  });
});

describe("tools por giro", () => {
  it("bot de BIRevX (Pro, sin BOT_NICHE): mismas tools de siempre", () => {
    expect(names(ctx("pro"))).toEqual([
      "cancelAppointment",
      "captureLead",
      "catalogQuery",
      "checkAvailability",
      "handoffHuman",
      "pauseBot",
      "pauseSuspectedBot",
      "rescheduleAppointment",
      "scheduleAppointment",
      "searchKb",
      "shareDocument",
      "snoozeUser",
    ]);
  });

  it("citas con agenda (Pro o Starter con FEATURE_AGENDA): se queda la agenda de Cal.com, sin registrarCita", () => {
    for (const id of CITAS) {
      for (const c of [ctx("pro", id), ctx("negocio", id), ctx("free", id, { FEATURE_AGENDA: "1" })]) {
        const t = buildTools(c);
        expect(t.scheduleAppointment).toBeDefined();
        expect(t.checkAvailability).toBeDefined();
        expect(t.registrarCita).toBeUndefined();
      }
    }
  });

  it("citas sin agenda (Starter sin FEATURE_AGENDA): registrarCita y ninguna tool de Cal.com", () => {
    for (const id of CITAS) {
      const t = buildTools(ctx("free", id));
      expect(t.registrarCita).toBeDefined();
      expect(t.scheduleAppointment).toBeUndefined();
      expect(t.checkAvailability).toBeUndefined();
    }
  });

  it("restaurante: crearReservacion y tomarPedido en cualquier nivel", () => {
    for (const tier of ["free", "negocio", "pro"] as const) {
      const t = buildTools(ctx(tier, "restaurante"));
      expect(t.crearReservacion).toBeDefined();
      expect(t.tomarPedido).toBeDefined();
      expect(t.registrarPedido).toBeUndefined();
      expect(t.registrarCita).toBeUndefined();
    }
  });

  it("tienda, panadería y cafetería: registrarPedido en cualquier nivel", () => {
    for (const id of ["tienda", "panaderia", "cafeteria"]) {
      for (const tier of ["free", "pro"] as const) {
        const t = buildTools(ctx(tier, id));
        expect(t.registrarPedido).toBeDefined();
        expect(t.crearReservacion).toBeUndefined();
        expect(t.registrarCita).toBeUndefined();
      }
    }
  });

  it("los giros de pedidos conservan su agenda según el nivel (no la tocan)", () => {
    expect(buildTools(ctx("pro", "restaurante")).scheduleAppointment).toBeDefined();
    expect(buildTools(ctx("free", "tienda")).scheduleAppointment).toBeUndefined();
  });
});

describe("prompt y panel", () => {
  it("el playbook del giro entra al prompt; sin giro, no", () => {
    const env = ctx("pro", "barberia").env as Env;
    const prompt = systemPromptFromEnv(env, ["searchKb", "registrarCita"], "ctx", getNiche(env).playbook || undefined);
    expect(prompt).toContain('<playbook name="agendar_cita">');
    const gen = ctx("pro").env as Env;
    expect(systemPromptFromEnv(gen, ["searchKb"], "ctx", getNiche(gen).playbook || undefined)).not.toContain(
      "<diagnostic_playbooks>",
    );
  });

  it("con giro, el nav cambia «Leads» por el nombre del giro; sin giro sigue igual", () => {
    const html = layout({ title: "T", activeTab: "leads", body: "x", env: ctx("pro", "restaurante").env as Env });
    expect(html).toContain("Reservaciones");
    const gen = layout({ title: "T", activeTab: "leads", body: "x", env: ctx("pro").env as Env });
    expect(gen).not.toContain("Reservaciones");
    expect(gen).toContain("Leads");
  });
});

describe("las tools registran en D1 con los datos del giro", () => {
  let env: any;
  let leads: LeadsRepo;
  let convId: string;

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = await mf.getD1Database("DB");
    const db = new Db(d1 as any);
    leads = new LeadsRepo(db);
    convId = (await new ConversationsRepo(db).getOrCreate("whatsapp", "u1")).id;
    env = { DB: d1, BOT_TIER: "free" };
  });

  const run = (t: any, input: any) => t.execute!(input, {} as any);

  it("registrarCita guarda servicio, con quién, fecha y hora", async () => {
    const r = await run(registrarCitaTool(env, () => convId), {
      nombre: "Ana",
      servicio: "corte + barba",
      fecha: "sábado",
      hora: "17:00",
      profesional: "Memo",
      contacto: "+5214440000000",
    });
    expect(r.citaId).toBeTruthy();
    expect(r.message).toContain("confirma");
    const [l] = await leads.list(10);
    expect(l.intent).toBe("Cita · corte + barba · sábado 17:00");
    expect(l.notes).toContain("Con: Memo");
    expect(leadMetadata(l)).toMatchObject({ servicio: "corte + barba", profesional: "Memo", fecha: "sábado", hora: "17:00" });
  });

  it("crearReservacion guarda mesa, fecha, hora y personas", async () => {
    await run(crearReservacionTool(env, () => convId), { nombre: "Luis", fecha: "viernes", hora: "21:00", personas: 4 });
    const [l] = await leads.list(10);
    expect(l.intent).toContain("4 pers.");
    expect(leadMetadata(l)).toMatchObject({ tipo: "Mesa", fecha: "viernes", hora: "21:00" });
  });

  it("tomarPedido guarda tipo, platillos, dirección y pago", async () => {
    await run(tomarPedidoTool(env, () => convId), {
      tipo: "delivery",
      platillos: "2 enchiladas",
      direccion: "Av. Carranza 100",
      pago: "efectivo",
    });
    const [l] = await leads.list(10);
    expect(leadMetadata(l)).toMatchObject({ tipo: "Delivery", platillos: "2 enchiladas", pago: "efectivo" });
    expect(l.notes).toContain("Dirección: Av. Carranza 100");
  });

  it("registrarPedido guarda productos, entrega, fecha y pago", async () => {
    await run(registrarPedidoTool(env, () => convId), {
      productos: "pastel de 3 leches para 20",
      entrega: "recoger",
      fecha: "domingo 12:00",
      pago: "transferencia",
    });
    const [l] = await leads.list(10);
    expect(leadMetadata(l)).toMatchObject({ productos: "pastel de 3 leches para 20", entrega: "Recoger", fecha: "domingo 12:00" });
  });
});
