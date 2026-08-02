#!/usr/bin/env bash
# One-command local bootstrap — see README.md "Getting Started".
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — fill in real secrets before Sprint 2+."
fi

docker compose -f docker/docker-compose.yml up -d
pnpm install
pnpm dev
