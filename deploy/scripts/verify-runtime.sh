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

configured_image="$(
  sed -n 's/^CODEX_EXPERIMENT_IMAGE=//p' "${compose_env_file}" | tail -n 1
)"
"${script_dir}/validate-image-ref.sh" "${configured_image}"

configured_edge_image="$(
  sed -n 's/^CODEX_EXPERIMENT_EDGE_IMAGE=//p' "${compose_env_file}" | tail -n 1
)"
public_host="$(
  sed -n 's/^CODEX_EXPERIMENT_PUBLIC_HOST=//p' "${compose_env_file}" | tail -n 1
)"
if [[ -z "${configured_edge_image}" || -z "${public_host}" ]]; then
  echo "Edge image and public host are required." >&2
  exit 1
fi
"${script_dir}/validate-image-ref.sh" "${configured_edge_image}"

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

edge_container_id="$("${compose[@]}" ps --quiet edge)"
if [[ -z "${edge_container_id}" ]]; then
  echo "Edge container is not running." >&2
  exit 1
fi

edge_health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
  "${edge_container_id}")"
if [[ "${edge_health_status}" != "healthy" ]]; then
  echo "Edge container health is ${edge_health_status}, not healthy." >&2
  exit 1
fi

runtime_edge_image="$(docker inspect --format '{{.Config.Image}}' "${edge_container_id}")"
if [[ "${runtime_edge_image}" != "${configured_edge_image}" ]]; then
  echo "Running edge image does not match Compose configuration." >&2
  exit 1
fi

edge_binding="$("${compose[@]}" port edge 443/tcp)"
if [[ "${edge_binding}" != "0.0.0.0:443" ]]; then
  echo "Unexpected HTTPS binding: ${edge_binding}" >&2
  exit 1
fi

curl --fail --silent --show-error \
  "http://127.0.0.1:4310/codex-experiment/api/health" \
  | grep -q '"ok":true'

for _ in {1..30}; do
  if curl --fail --silent --show-error --connect-timeout 3 --max-time 8 \
    "https://${public_host}/codex-experiment/api/health" \
    | grep -q '"ok":true'; then
    public_ready=true
    break
  fi
  sleep 2
done
if [[ "${public_ready:-false}" != "true" ]]; then
  echo "Public HTTPS endpoint did not become healthy." >&2
  exit 1
fi

read -r unauthenticated_status unauthenticated_redirect < <(
  curl --silent --show-error --connect-timeout 3 --max-time 8 \
    --output /dev/null --write-out '%{http_code} %{redirect_url}\n' \
    "https://${public_host}/codex-experiment/console"
)
expected_login_url="https://${public_host}/codex-experiment/login"
if [[ "${unauthenticated_status}" != "307" \
  || "${unauthenticated_redirect}" != "${expected_login_url}" ]]; then
  echo "Unauthenticated console did not redirect to login." >&2
  exit 1
fi

origin_status="$(
  curl --silent --show-error --connect-timeout 3 --max-time 8 \
    --output /dev/null --write-out '%{http_code}' \
    --request POST \
    --header "Origin: https://${public_host}" \
    --header 'Content-Type: application/json' \
    --data '{}' \
    "https://${public_host}/codex-experiment/api/auth/login"
)"
if [[ "${origin_status}" != "400" ]]; then
  echo "Public login origin validation failed with status ${origin_status}." >&2
  exit 1
fi

worker_api_status="$(
  curl --silent --show-error --connect-timeout 3 --max-time 8 \
    --output /dev/null --write-out '%{http_code}' \
    "https://${public_host}/codex-experiment/api/worker/claim"
)"
if [[ "${worker_api_status}" != "404" ]]; then
  echo "Worker API is unexpectedly reachable through the public edge." >&2
  exit 1
fi

echo "Runtime verification passed."
echo "image=${runtime_image}"
echo "edge_image=${runtime_edge_image}"
echo "binding=${published_port}"
echo "https_binding=${edge_binding}"
echo "public_url=https://${public_host}/codex-experiment"
