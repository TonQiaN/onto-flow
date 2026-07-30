#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
compose_file="${COMPOSE_FILE:-${repo_root}/docker-compose.yml}"
compose_env_file="${COMPOSE_ENV_FILE:-/opt/codex-sdk-experiment/config/compose.env}"
project_name="codex-sdk-experiment"

compose=(
  docker compose
  --project-name "${project_name}"
  --env-file "${compose_env_file}"
  --file "${compose_file}"
)

configured_image="$("${compose[@]}" config --images | head -n 1)"
"${script_dir}/validate-image-ref.sh" "${configured_image}"

published_port="$("${compose[@]}" port web 3000)"
if [[ "${published_port}" != "127.0.0.1:4310" ]]; then
  echo "Unexpected public binding: ${published_port}" >&2
  exit 1
fi

container_id="$("${compose[@]}" ps --quiet web)"
if [[ -z "${container_id}" ]]; then
  echo "Web container is not running." >&2
  exit 1
fi

health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
  "${container_id}")"
if [[ "${health_status}" != "healthy" ]]; then
  echo "Container health is ${health_status}, not healthy." >&2
  exit 1
fi

runtime_image="$(docker inspect --format '{{.Config.Image}}' "${container_id}")"
if [[ "${runtime_image}" != "${configured_image}" ]]; then
  echo "Running image does not match Compose configuration." >&2
  exit 1
fi

curl --fail --silent --show-error \
  "http://127.0.0.1:4310/codex-experiment/api/health" \
  | grep -q '"ok":true'

echo "Runtime verification passed."
echo "image=${runtime_image}"
echo "binding=${published_port}"
