import { describe, it, expect } from "vitest";
import { nivel, tiene, pestanaBloqueada, agendaDisponible, agendaBasica, isPro, isToolAvailable } from "../src/config";
import { adminApp } from "../src/admin/routes";
import { createTestMiniflare } from "./helpers/miniflareSetup";

const env = (BOT_TIER: string, extra: Record<string, string> = {}) => ({ BOT_TIER, ...extra }) as any;

describe("niveles Starter → Negocio → Pro (F3)", () => {
  it("lee el nivel; free es alias de starter; isPro no cambia", () => {
    expect(nivel(env("free"))).toBe("starter");
    expect(nivel(env("starter"))).toBe("starter");
    expect(nivel(env("negocio"))).toBe("negocio");
    expect(nivel(env("pro"))).toBe("pro");
    expect(isPro(env("negocio"))).toBe(false);
  });
  it("el Negocio gana agenda completa y reporte diario, pero no catálogo ni cobros", () => {
    expect(tiene(env("negocio"), "agendaCompleta")).toBe(true);
    expect(tiene(env("negocio"), "reporteDiario")).toBe(true);
    expect(tiene(env("negocio"), "catalogo")).toBe(false);
    expect(tiene(env("negocio"), "cobrosPorChat")).toBe(false);
    expect(tiene(env("starter"), "agendaCompleta")).toBe(false);
    expect(agendaDisponible(env("negocio"))).toBe(true);
    expect(agendaBasica(env("negocio", { FEATURE_AGENDA: "1" }))).toBe(false);
    expect(agendaBasica(env("starter", { FEATURE_AGENDA: "1" }))).toBe(true);
    expect(isToolAvailable(env("negocio"), "catalogQuery")).toBe(false);
    expect(isToolAvailable(env("pro"), "catalogQuery")).toBe(true);
  });
  it("pestañas: el Negocio ve Reportes y Plantillas; Campañas y Cobros siguen en Pro", () => {
    expect(pestanaBloqueada(env("negocio"), "report")).toBeNull();
    expect(pestanaBloqueada(env("negocio"), "plantillas")).toBeNull();
    expect(pestanaBloqueada(env("negocio"), "campanas")).toBe("pro");
    expect(pestanaBloqueada(env("starter"), "report")).toBe("negocio");
    expect(pestanaBloqueada(env("pro"), "cobros")).toBeNull();
    expect(pestanaBloqueada(env("starter"), "leads")).toBeNull();
  });
  it("el panel de un Negocio abre Reportes, manda Campañas a la página de mejora y rotula el nivel en el menú", async () => {
    const mf = await createTestMiniflare();
    const e = { DB: await mf.getD1Database("DB"), DASHBOARD_PASSWORD: "pw", BOT_TIER: "negocio", BUSINESS_NAME: "T", BOT_LANGUAGE: "es" } as any;
    const h = { Authorization: "Basic " + btoa("admin:pw") };
    const campanas = await (await adminApp.request("/campanas", { headers: h }, e)).text();
    expect(campanas).toContain("desde Pro");
    const leads = await (await adminApp.request("/leads", { headers: h }, e)).text();
    expect(leads).toContain("· Negocio");
    expect(leads).toMatch(/Campañas[\s\S]{0,400}PRO/);
  });
});
