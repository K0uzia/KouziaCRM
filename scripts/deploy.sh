#!/usr/bin/env bash
# Mise à jour prod sans perte de données.
# La base SQLite vit dans ./data sur l'hôte (volume bind), jamais dans l'image Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

echo "==> KouziaCRM : mise à jour (données conservées dans ${ROOT}/data/)"
git pull

echo "==> Build incrémental (cache Docker, pas de --no-cache)…"
docker compose build app

echo "==> Redémarrage des services…"
docker compose up -d

echo "==> État :"
docker compose ps

echo ""
echo "OK. Base SQLite : ${ROOT}/data/kouziacrm.db"
echo "Les rebuilds Docker ne touchent pas ./data (volume monté depuis l'hôte)."
