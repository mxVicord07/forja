#!/usr/bin/env bash
# Reindexa la base de conocimiento de birevx-support-bot en Vectorize.
# Rota KB_REINDEX_TOKEN (el valor guardado en Cloudflare no se puede leer), lo guarda en .dev.vars (local, gitignored)
# y llama POST /kb/reindex. No imprime el token. Orden correcto (ver src/index.ts): manifiesto -> deploy -> secret -> reindex.
# Uso: bash scripts/reindex-kb.sh          (el deploy y el manifiesto ya deben estar hechos)
set -euo pipefail
cd "$(dirname "$0")/.."
URL="https://birevx-support-bot.victor-m-426.workers.dev/kb/reindex"

TOKEN="$(openssl rand -hex 32)"
echo "1/3 Guardando el token nuevo en Cloudflare (secret)"
printf '%s' "$TOKEN" | pnpm exec wrangler secret put KB_REINDEX_TOKEN >/dev/null
echo "2/3 Guardando el token en .dev.vars (local)"
touch .dev.vars && chmod 600 .dev.vars
grep -v '^KB_REINDEX_TOKEN=' .dev.vars > .dev.vars.tmp || true
printf 'KB_REINDEX_TOKEN=%s\n' "$TOKEN" >> .dev.vars.tmp
mv .dev.vars.tmp .dev.vars && chmod 600 .dev.vars

echo "3/3 Reindexando (el secret tarda unos segundos en propagarse; reintenta solo)"
for i in 1 2 3 4 5 6; do
  sleep 8
  RESP="$(curl -s -X POST "$URL" -H "X-Reindex-Token: $TOKEN" || true)"
  if echo "$RESP" | grep -q '"ok":true'; then echo "Listo: $RESP"; unset TOKEN; exit 0; fi
  echo "  intento $i: aún no ($RESP)"
done
unset TOKEN
echo "No respondió ok. Espera un minuto y repite: bash scripts/reindex-kb.sh" >&2
exit 1
