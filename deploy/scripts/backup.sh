#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
compose_file="${COMPOSE_FILE:-${repo_root}/docker-compose.yml}"
compose_env_file="${COMPOSE_ENV_FILE:-/opt/codex-sdk-experiment/config/compose.env}"
project_name="codex-sdk-experiment"
data_dir="${DATA_DIR:-/opt/codex-sdk-experiment/data}"
backup_dir="${BACKUP_DIR:-/opt/codex-sdk-experiment/backups}"
retention_days="${RETENTION_DAYS:-30}"

case "${data_dir}" in
  /opt/codex-sdk-experiment/data) ;;
  *)
    echo "Refusing unexpected DATA_DIR: ${data_dir}" >&2
    exit 1
    ;;
esac

case "${backup_dir}" in
  /opt/codex-sdk-experiment/backups | /opt/codex-sdk-experiment/backups/*) ;;
  *)
    echo "Refusing unexpected BACKUP_DIR: ${backup_dir}" >&2
    exit 1
    ;;
esac

for command_name in docker sqlite3 tar sha256sum; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -r "${compose_file}" || ! -r "${compose_env_file}" ]]; then
  echo "Compose file or compose environment file is not readable." >&2
  exit 1
fi

if [[ ! -f "${data_dir}/app.sqlite" ]]; then
  echo "Database not found: ${data_dir}/app.sqlite" >&2
  exit 1
fi

compose=(
  docker compose
  --project-name "${project_name}"
  --env-file "${compose_env_file}"
  --file "${compose_file}"
)

web_was_running=false
if "${compose[@]}" ps --status running --services | grep -Fxq web; then
  web_was_running=true
  "${compose[@]}" stop --timeout 30 web
fi

restart_web() {
  local exit_code=$?
  trap - EXIT
  if [[ "${web_was_running}" == "true" ]]; then
    if ! "${compose[@]}" up --detach --no-deps web; then
      echo "Backup finished or failed, but the web service did not restart." >&2
      exit 1
    fi
  fi
  exit "${exit_code}"
}
trap restart_web EXIT

integrity_result="$(sqlite3 -batch -noheader "${data_dir}/app.sqlite" \
  "PRAGMA integrity_check;")"
if [[ "${integrity_result}" != "ok" ]]; then
  echo "SQLite integrity check failed; no backup was created." >&2
  exit 1
fi

missing_screenshot=false
while IFS= read -r screenshot_filename; do
  [[ -z "${screenshot_filename}" ]] && continue
  if [[ ! -f "${data_dir}/screenshots/${screenshot_filename}" ]]; then
    echo "Referenced screenshot is missing: ${screenshot_filename}" >&2
    missing_screenshot=true
  fi
done < <(
  sqlite3 -batch -noheader "${data_dir}/app.sqlite" \
    "SELECT screenshot_filename
       FROM message_jobs
      WHERE screenshot_filename IS NOT NULL
      ORDER BY screenshot_filename;"
)

if [[ "${missing_screenshot}" == "true" ]]; then
  echo "Screenshot consistency check failed; no backup was created." >&2
  exit 1
fi

mkdir -p "${backup_dir}"
chmod 0700 "${backup_dir}"

timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
archive_name="codex-sdk-experiment-${timestamp}.tar.gz"
archive_path="${backup_dir}/${archive_name}"
temporary_archive="${archive_path}.partial"

tar --create --gzip --file "${temporary_archive}" \
  --directory "${data_dir}" .
mv "${temporary_archive}" "${archive_path}"

(
  cd "${backup_dir}"
  sha256sum "${archive_name}" > "${archive_name}.sha256"
)

image_ref="$(
  sed -n 's/^CODEX_EXPERIMENT_IMAGE=//p' "${compose_env_file}" | tail -n 1
)"
{
  printf 'created_at=%s\n' "${timestamp}"
  printf 'project=%s\n' "${project_name}"
  printf 'image=%s\n' "${image_ref}"
  printf 'backup_kind=cold-data-directory\n'
} > "${archive_path}.metadata"

BACKUP_DIR="${backup_dir}" RETENTION_DAYS="${retention_days}" \
  "${script_dir}/prune-backups.sh"

echo "Created consistent backup: ${archive_path}"
