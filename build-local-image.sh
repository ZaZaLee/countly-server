#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

compose_cmd=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    compose_cmd=(docker-compose)
  else
    echo "docker compose or docker-compose is required" >&2
    exit 1
  fi
fi

echo "Pulling latest code in $script_dir"
git pull --ff-only --autostash

image_name="${COUNTLY_LOCAL_IMAGE:-soda-countly:local}"

echo "Building local Countly image: $image_name"
docker build --pull -f Dockerfile-core -t "$image_name" .

echo "Build finished. Start with: ${compose_cmd[*]} -f docker-compose.yml up -d"
