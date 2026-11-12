/**
 * Alta de un bot Forja para un cliente nuevo con un comando (paso 9 del plan de Forja Pro, 12-nov-2026).
 * Automatiza los pasos 1 a 4 de FORJA/playbooks/aprovisionamiento-cloudflare-nuevo-cliente.md.
 *
 *   pnpm alta-cliente <slug> --nombre "Nombre del negocio" --destino ~/Dev/<slug>-forja-bot [--aplicar]
 *
 * Sin --aplicar SOLO muestra el plan (nombres, recursos, archivo de configuración y secretos que faltan): no
 * crea nada ni escribe nada. Con --aplicar:
 *   1. Revisa que ningún recurso con esos nombres exista ya en la cuenta (si alguno existe, se detiene).
 *   2. Crea D1, Vectorize (1024 dimensiones, coseno: el modelo bge-m3 de src/kb/reindex.ts) y los dos buckets R2.
 *   3. Escribe <destino>/wrangler.toml con los ids reales. Nunca sobrescribe uno que ya diga el nombre del cliente.
 *   4. Revisa que en <destino> no queden rastros de BIRevX (nombre del Worker, base de conocimiento, negocio).
 * Nunca pone secretos: imprime la lista de `wrangler secret put` para que el dueño los cargue a mano.
 *
 * Reglas de la decisión del 27-ago-2026: un Worker, una base, un índice y buckets por cliente, todos en la cuenta
 * de Cloudflare de BIRevX; el prefijo del cliente en todo para no mezclar recursos.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Recursos {
  worker: string;
  d1: string;
  vectorize: string;
  r2Media: string;
  r2Catalog: string;
}

const RESERVADOS = new Set(["birevx", "forja", "horizontes", "admin", "test", "prueba"]);

/** Slug: minúsculas, números y guiones; de 3 a 30; empieza con letra; sin guion al final ni doble guion. */
export function validarSlug(slug: string): string | null {
  if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(slug)) return "El slug debe tener de 3 a 30 caracteres: minúsculas, números y guiones, empezar con letra y no terminar en guion.";
  if (slug.includes("--")) return "El slug no puede llevar dos guiones seguidos.";
  if (RESERVADOS.has(slug)) return `«${slug}» está reservado.`;
  return null;
}

export function nombresRecursos(slug: string): Recursos {
  return {
    worker: `${slug}-support-bot`,
    d1: `${slug}-db`,
    vectorize: `${slug}-kb`,
    r2Media: `${slug}-media`,
    r2Catalog: `${slug}-catalog`,
  };
}

/** Lee el id que imprime `wrangler d1 create` (formato TOML de versiones viejas o JSON de las nuevas). */
export function leerIdD1(salida: string): string | null {
  const m = salida.match(/database_id"?\s*[=:]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i);
  return m ? m[1] : null;
}

/** Nombres que ya existen en la cuenta (se pasan ya leídos de wrangler). Devuelve los que chocan. */
export function colisiones(r: Recursos, existentes: { d1: string[]; vectorize: string[]; r2: string[]; workers: string[] }): string[] {
  const out: string[] = [];
  if (existentes.workers.includes(r.worker)) out.push(`Worker ${r.worker}`);
  if (existentes.d1.includes(r.d1)) out.push(`D1 ${r.d1}`);
  if (existentes.vectorize.includes(r.vectorize)) out.push(`Vectorize ${r.vectorize}`);
  for (const b of [r.r2Media, r.r2Catalog]) if (existentes.r2.includes(b)) out.push(`R2 ${b}`);
  return out;
}

const tomlTexto = (s: string) => JSON.stringify(s); // comillas y escapes válidos en TOML

/**
 * wrangler.toml del cliente, armado desde cero (no se copia el de BIRevX para no arrastrar sus valores).
 * Bindings y crons idénticos a los que el código espera (src/env.ts y src/crons/schedule.ts).
 */
export function renderWranglerToml(slug: string, nombreNegocio: string, d1Id: string): string {
  const r = nombresRecursos(slug);
  return `# Generado por scripts/alta-cliente.ts para el cliente «${slug}». Los secretos van con \`wrangler secret put\`, nunca aquí.

name = ${tomlTexto(r.worker)}
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"

[[durable_objects.bindings]]
name = "AGENT"
class_name = "SupportAgent"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SupportAgent"]

[[d1_databases]]
binding = "DB"
database_name = ${tomlTexto(r.d1)}
database_id = ${tomlTexto(d1Id)}

[[vectorize]]
binding = "KB"
index_name = ${tomlTexto(r.vectorize)}

[[r2_buckets]]
binding = "CATALOG"
bucket_name = ${tomlTexto(r.r2Catalog)}

[[r2_buckets]]
binding = "MEDIA"
bucket_name = ${tomlTexto(r.r2Media)}

[vars]
BOT_NAME = ${tomlTexto(`${nombreNegocio} Bot`)}
BUSINESS_NAME = ${tomlTexto(nombreNegocio)}
BOT_LANGUAGE = "es"
BOT_TIER = "pro"
BUFFER_SECONDS = "15"
# Respaldo semanal a R2 (domingos). Quitar esta línea lo apaga.
FEATURE_RESPALDO_SEMANAL = "1"

[triggers]
# No quitar "0 3 * * *": los trabajos nocturnos solo corren en ese tick (src/crons/schedule.ts).
crons = [
  "0 3 * * *",
  "0 * * * *",
]
`;
}

/** Secretos mínimos que el dueño carga a mano (nombres, nunca valores). */
export const SECRETOS = [
  ["ANTHROPIC_API_KEY", "llave de IA del cliente (o la que se acuerde)"],
  ["DASHBOARD_PASSWORD", "contraseña del panel /admin (gestor de contraseñas)"],
  ["KB_REINDEX_TOKEN", "token para reindexar la base de conocimiento"],
  ["OWNER_TELEGRAM_CHAT_ID", "a dónde llegan los avisos del dueño"],
] as const;

/** Rastros de BIRevX en la carpeta del cliente. Lista vacía = limpio. */
export function rastrosBirevx(destino: string, kbBirevx: string[]): string[] {
  const out: string[] = [];
  const toml = join(destino, "wrangler.toml");
  if (existsSync(toml)) {
    const t = readFileSync(toml, "utf8");
    if (/birevx-support-bot|horizontes_bot_db|horizontes_bot_kb|\+524444237875/i.test(t)) out.push("wrangler.toml todavía apunta a recursos o al número de BIRevX");
  }
  const kbDir = join(destino, "member", "kb");
  if (existsSync(kbDir)) {
    const propios = new Set(kbBirevx);
    const repetidos = readdirSync(kbDir).filter((f) => f.endsWith(".md") && propios.has(f));
    if (repetidos.length) out.push(`member/kb tiene ${repetidos.length} documento(s) de BIRevX (p. ej. ${repetidos[0]})`);
  }
  const cfg = join(destino, "member", "config.local.ts");
  if (existsSync(cfg) && /BIRevX/i.test(readFileSync(cfg, "utf8"))) out.push("member/config.local.ts todavía menciona a BIRevX");
  return out;
}

// ── Ejecución ────────────────────────────────────────────────────────────────

function wr(args: string[]): string {
  return execFileSync("pnpm", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function listarExistentes(worker: string): { d1: string[]; vectorize: string[]; r2: string[]; workers: string[] } {
  const nombres = (json: string) => {
    try { return (JSON.parse(json.slice(json.indexOf("["))) as { name?: string }[]).map((x) => String(x.name ?? "")); } catch { return []; }
  };
  const d1 = nombres(wr(["d1", "list", "--json"]));
  const vectorize = nombres(wr(["vectorize", "list", "--json"]));
  const r2 = wr(["r2", "bucket", "list"]).split("\n").map((l) => l.match(/^name:\s*(\S+)/)?.[1]).filter((x): x is string => !!x);
  // Workers: wrangler no los lista todos. Se piden los despliegues de ESE nombre: si responde, el Worker ya existe y
  // desplegar con ese nombre sobrescribiría el bot de otro cliente; si falla (no existe), el nombre está libre.
  let workers: string[] = [];
  try { wr(["deployments", "list", "--name", worker]); workers = [worker]; } catch { workers = []; }
  return { d1, vectorize, r2, workers };
}

const esMain = /alta-cliente\.ts$/.test(String(process.argv[1] ?? ""));
if (esMain) {
  const args = process.argv.slice(2);
  const CON_VALOR = new Set(["--nombre", "--destino"]);
  const slug = args.find((a, i) => !a.startsWith("--") && !CON_VALOR.has(args[i - 1] ?? "")) ?? "";
  const valor = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? "" : ""; };
  const nombre = valor("--nombre").trim();
  const destino = valor("--destino") ? resolve(valor("--destino").replace(/^~/, process.env.HOME ?? "~")) : "";
  const aplicar = args.includes("--aplicar");

  const err = validarSlug(slug) ?? (!nombre ? "Falta --nombre \"Nombre del negocio\"." : null) ?? (!destino ? "Falta --destino <carpeta del repo del cliente>." : null);
  if (err) { console.error(`✗ ${err}`); process.exit(1); }

  const r = nombresRecursos(slug);
  console.log(`Alta de «${nombre}» (${slug})\n`);
  console.log(`  Worker     ${r.worker}\n  D1         ${r.d1}\n  Vectorize  ${r.vectorize} (1024, coseno)\n  R2         ${r.r2Media}, ${r.r2Catalog}\n  Carpeta    ${destino}\n`);

  const kbBirevx = readdirSync(join(process.cwd(), "member", "kb")).filter((f) => f.endsWith(".md"));
  if (!existsSync(destino)) {
    console.log(`La carpeta no existe. Créala antes con:\n  git clone <repo de Forja> ${destino}\n  (y vacía member/kb y member/config.local.ts: son de BIRevX)\n`);
  } else {
    const rastros = rastrosBirevx(destino, kbBirevx);
    if (rastros.length) console.log(`Rastros de BIRevX en la carpeta del cliente:\n  - ${rastros.join("\n  - ")}\n`);
  }

  if (!aplicar) {
    console.log("Simulación: no se creó nada. Agrega --aplicar para crear los recursos en Cloudflare.");
    process.exit(0);
  }
  if (!existsSync(destino)) { console.error("✗ La carpeta del cliente no existe."); process.exit(1); }
  const tomlDestino = join(destino, "wrangler.toml");
  if (existsSync(tomlDestino) && readFileSync(tomlDestino, "utf8").includes(r.worker)) {
    console.error(`✗ ${tomlDestino} ya es de este cliente: no se sobrescribe.`); process.exit(1);
  }

  const choques = colisiones(r, listarExistentes(r.worker));
  if (choques.length) { console.error(`✗ Ya existen en la cuenta: ${choques.join(", ")}. No se creó nada.`); process.exit(1); }

  const salidaD1 = wr(["d1", "create", r.d1]);
  const d1Id = leerIdD1(salidaD1);
  if (!d1Id) { console.error("✗ No se pudo leer el id de la base nueva. Revisa en el panel de Cloudflare antes de reintentar."); process.exit(1); }
  wr(["vectorize", "create", r.vectorize, "--dimensions=1024", "--metric=cosine"]);
  wr(["r2", "bucket", "create", r.r2Media]);
  wr(["r2", "bucket", "create", r.r2Catalog]);
  writeFileSync(tomlDestino, renderWranglerToml(slug, nombre, d1Id));
  console.log(`✓ Recursos creados y ${tomlDestino} escrito.\n`);

  const rastros = rastrosBirevx(destino, kbBirevx);
  if (rastros.length) console.log(`⚠ Antes de desplegar, limpia:\n  - ${rastros.join("\n  - ")}\n`);
  console.log("Siguientes pasos (en la carpeta del cliente):");
  console.log(`  cd ${destino}`);
  console.log("  pnpm install");
  console.log(`  pnpm wrangler d1 execute ${r.d1} --file=src/db/schema.sql --remote`);
  for (const [s, para] of SECRETOS) console.log(`  pnpm wrangler secret put ${s}    # ${para}`);
  console.log("  pnpm run deploy");
  console.log("Luego: canales desde /admin/conexiones y la verificación final del playbook (paso 8).");
}
