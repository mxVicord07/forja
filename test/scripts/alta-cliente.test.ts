import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validarSlug, nombresRecursos, leerIdD1, colisiones, renderWranglerToml, rastrosBirevx, SECRETOS } from "../../scripts/alta-cliente";

describe("validarSlug", () => {
  it("acepta slugs normales", () => {
    for (const s of ["ap-salon", "fenix", "club-padel-2"]) expect(validarSlug(s)).toBeNull();
  });
  it("rechaza formatos malos y reservados", () => {
    for (const s of ["", "ab", "Fenix", "1fenix", "fenix-", "fe--nix", "fénix", "a".repeat(31), "birevx", "forja"]) expect(validarSlug(s)).not.toBeNull();
  });
});

describe("nombresRecursos y colisiones", () => {
  it("prefija todo con el slug", () => {
    expect(nombresRecursos("fenix")).toEqual({ worker: "fenix-support-bot", d1: "fenix-db", vectorize: "fenix-kb", r2Media: "fenix-media", r2Catalog: "fenix-catalog" });
  });
  it("detecta recursos que ya existen", () => {
    const r = nombresRecursos("fenix");
    expect(colisiones(r, { d1: ["fenix-db"], vectorize: [], r2: ["fenix-catalog"], workers: [] })).toEqual(["D1 fenix-db", "R2 fenix-catalog"]);
    expect(colisiones(r, { d1: ["otro-db"], vectorize: [], r2: [], workers: [] })).toEqual([]);
  });
});

describe("leerIdD1", () => {
  it("lee el id de la salida de wrangler", () => {
    const salida = '✅ Successfully created DB \'fenix-db\'\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "fenix-db"\ndatabase_id = "e67b7241-4bbf-45f1-9a20-156163a01e7b"';
    expect(leerIdD1(salida)).toBe("e67b7241-4bbf-45f1-9a20-156163a01e7b");
    expect(leerIdD1('"database_id": "e67b7241-4bbf-45f1-9a20-156163a01e7b"')).toBe("e67b7241-4bbf-45f1-9a20-156163a01e7b");
    expect(leerIdD1("error")).toBeNull();
  });
});

describe("renderWranglerToml", () => {
  const toml = renderWranglerToml("fenix", 'Barbería "Fénix"', "11111111-2222-3333-4444-555555555555");
  it("usa solo recursos del cliente y ningún valor de BIRevX", () => {
    expect(toml).toContain('name = "fenix-support-bot"');
    expect(toml).toContain('database_name = "fenix-db"');
    expect(toml).toContain('index_name = "fenix-kb"');
    expect(toml).toContain('bucket_name = "fenix-media"');
    expect(toml).toContain('bucket_name = "fenix-catalog"');
    expect(toml).not.toMatch(/birevx-support-bot|horizontes_bot|524444237875|YCLOUD|CALCOM|cal\.com/i);
  });
  it("escapa comillas del nombre del negocio", () => {
    expect(toml).toContain('BUSINESS_NAME = "Barbería \\"Fénix\\""');
  });
  it("conserva bindings y crons que el código espera", () => {
    expect(toml).toContain('binding = "DB"');
    expect(toml).toContain('binding = "KB"');
    expect(toml).toContain('class_name = "SupportAgent"');
    expect(toml).toContain('"0 3 * * *"');
    expect(toml).toContain('FEATURE_RESPALDO_SEMANAL = "1"');
  });
  it("no trae secretos", () => {
    expect(toml).not.toMatch(/API_KEY\s*=|PASSWORD\s*=|TOKEN\s*=/);
    expect(SECRETOS.map(([s]) => s)).toContain("DASHBOARD_PASSWORD");
  });
});

describe("rastrosBirevx", () => {
  it("encuentra el toml, la base y la configuración de BIRevX en la carpeta del cliente", () => {
    const d = mkdtempSync(join(tmpdir(), "alta-"));
    mkdirSync(join(d, "member", "kb"), { recursive: true });
    writeFileSync(join(d, "wrangler.toml"), 'name = "birevx-support-bot"');
    writeFileSync(join(d, "member", "kb", "precios-asistentes.md"), "x");
    writeFileSync(join(d, "member", "config.local.ts"), "businessName: 'BIRevX'");
    const r = rastrosBirevx(d, ["precios-asistentes.md"]);
    expect(r).toHaveLength(3);
  });
  it("una carpeta limpia no reporta nada", () => {
    const d = mkdtempSync(join(tmpdir(), "alta-"));
    mkdirSync(join(d, "member", "kb"), { recursive: true });
    writeFileSync(join(d, "member", "kb", "horarios.md"), "x");
    writeFileSync(join(d, "wrangler.toml"), renderWranglerToml("fenix", "Fénix", "11111111-2222-3333-4444-555555555555"));
    expect(rastrosBirevx(d, ["precios-asistentes.md"])).toEqual([]);
  });
});
