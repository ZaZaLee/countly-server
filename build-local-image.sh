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
base_image="${COUNTLY_LOCAL_BASE_IMAGE:-${image_name%:*}:base}"

default_proxy="http://127.0.0.1:7890"
default_no_proxy="localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,.ivolces.com"

proxy="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
if [[ -z "$proxy" && "${COUNTLY_BUILD_USE_LOCAL_PROXY:-1}" == "1" ]]; then
  proxy="$default_proxy"
fi

no_proxy="${NO_PROXY:-${no_proxy:-$default_no_proxy}}"

if [[ "${COUNTLY_FULL_BUILD:-0}" != "1" ]]; then
  if docker image inspect "$base_image" >/dev/null 2>&1; then
    build_mode="overlay"
  elif docker image inspect "$image_name" >/dev/null 2>&1; then
    echo "Creating local build base image: $base_image <- $image_name"
    docker tag "$image_name" "$base_image"
    build_mode="overlay"
  else
    build_mode="full"
  fi
else
  build_mode="full"
fi

if [[ "$build_mode" == "overlay" ]]; then
  build_args=(-f Dockerfile-local-overlay --build-arg "BASE_IMAGE=$base_image" -t "$image_name")
else
  build_args=(-f Dockerfile-core -t "$image_name")
  if [[ "${COUNTLY_BUILD_PULL:-0}" == "1" ]]; then
    build_args=(--pull "${build_args[@]}")
  fi
fi

if [[ -n "$proxy" ]]; then
  echo "Using build proxy: $proxy"
  build_args+=(--network=host)
  build_args+=(--build-arg "HTTP_PROXY=$proxy")
  build_args+=(--build-arg "HTTPS_PROXY=$proxy")
  build_args+=(--build-arg "http_proxy=$proxy")
  build_args+=(--build-arg "https_proxy=$proxy")
  build_args+=(--build-arg "NO_PROXY=$no_proxy")
  build_args+=(--build-arg "no_proxy=$no_proxy")
fi

echo "Building local Countly image: $image_name ($build_mode)"
docker build "${build_args[@]}" .

if [[ "$build_mode" == "full" && "${COUNTLY_UPDATE_BASE_IMAGE:-1}" == "1" ]]; then
  echo "Updating local build base image: $base_image <- $image_name"
  docker tag "$image_name" "$base_image"
fi

echo "Build finished. Start with: ${compose_cmd[*]} -f docker-compose.yml up -d"
