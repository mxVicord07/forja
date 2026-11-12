import { describe, it, expect } from "vitest";
import { panelBrand } from "../../src/admin/brand";
import { layout } from "../../src/admin/views/layout";
import { BRAND_LOGO_DATA_URI } from "../../src/admin/assets/brand-logo";

const env = (over: Record<string, string> = {}) => ({ BOT_TIER: "pro", BUSINESS_NAME: "T", BOT_LANGUAGE: "es", ...over }) as any;

describe("panelBrand", () => {
  it("sin configuración devuelve la marca de BIRevX de siempre", () => {
    expect(panelBrand(env())).toEqual({ logo: BRAND_LOGO_DATA_URI, name: "BIRevX", byline: "by BIRevX" });
  });

  it("acepta un logotipo https y un nombre propio", () => {
    const b = panelBrand(env({ PANEL_BRAND_LOGO_URL: "https://cdn.cliente.com/logo.png", PANEL_BRAND_NAME: "Barbería Fénix" }));
    expect(b.logo).toBe("https://cdn.cliente.com/logo.png");
    expect(b.name).toBe("Barbería Fénix");
    expect(b.byline).toBe("Barbería Fénix");
  });

  it("el byline propio manda sobre el nombre", () => {
    expect(panelBrand(env({ PANEL_BRAND_NAME: "Fénix", PANEL_BRAND_BYLINE: "con Forja" })).byline).toBe("con Forja");
  });

  it("rechaza logotipos que no sean https o imagen en base64 y vuelve al de BIRevX", () => {
    for (const bad of ["http://x.com/l.png", "javascript:alert(1)", "//x.com/l.png", 'https://x.com/"onerror=1', "data:text/html;base64,AAAA", "https://x.com/a b.png"]) {
      expect(panelBrand(env({ PANEL_BRAND_LOGO_URL: bad })).logo).toBe(BRAND_LOGO_DATA_URI);
    }
    expect(panelBrand(env({ PANEL_BRAND_LOGO_URL: "data:image/png;base64,iVBORw0KGgo=" })).logo).toContain("data:image/png");
  });

  it("recorta el nombre a 40 caracteres", () => {
    expect(panelBrand(env({ PANEL_BRAND_NAME: "x".repeat(80) })).name).toHaveLength(40);
  });
});

describe("layout con marca propia", () => {
  it("por omisión sigue diciendo BIRevX", () => {
    const html = layout({ title: "t", activeTab: "tickets", body: "", env: env() });
    expect(html).toContain("by BIRevX");
    expect(html).toContain('alt="BIRevX"');
  });

  it("con marca propia muestra su logotipo y su nombre, escapados", () => {
    const html = layout({
      title: "t", activeTab: "tickets", body: "",
      env: env({ PANEL_BRAND_LOGO_URL: "https://cdn.cliente.com/logo.png", PANEL_BRAND_NAME: "Fénix <b>&" }),
    });
    expect(html).toContain('src="https://cdn.cliente.com/logo.png"');
    expect(html).toContain("Fénix &lt;b&gt;&amp;");
    expect(html).not.toContain("by BIRevX");
    expect(html).not.toContain("<b>&");
  });
});
