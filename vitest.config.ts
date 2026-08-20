import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Safety net: `agents` / `partyserver` import the virtual `cloudflare:*`
    // modules (only available inside workerd). The worker-entry test mocks the
    // `agents` package so these never load in Node, but if any test transitively
    // pulls them in, these aliases resolve them to local stubs rather than
    // crashing Node's ESM loader. Tests needing real runtime behavior use
    // Miniflare instead.
    alias: {
      "cloudflare:workers": path.resolve(HERE, "test/stubs/cloudflare-workers.ts"),
      "cloudflare:email": path.resolve(HERE, "test/stubs/cloudflare-email.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // Vitest 4 ELIMINÓ `poolOptions`; el antiguo `forks.singleFork` se ignoraba
    // en silencio y cada archivo levantaba su propio workerd en paralelo, lo que
    // agota el loopback (EADDRNOTAVAIL al bind de 127.0.0.1). Casi todos estos
    // tests arrancan un Miniflare real con el esquema D1 completo, así que la
    // serialización no es una preferencia: es un requisito.
    // Medido el 2026-08-19: en paralelo 96/717 fallan por bind; serializado
    // 717/717 pasan. Equivale a `--no-file-parallelism`.
    fileParallelism: false,
    // Most tests spin up a real Miniflare (workerd process + full D1 schema)
    // in beforeEach; under machine load that alone can blow the 5s default.
    // These are integration tests — give them real headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
