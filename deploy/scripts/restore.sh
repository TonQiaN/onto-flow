#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /opt/codex-sdk-experiment/backups/<backup>.tar.gz" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
compose_file="${COMPOSE_FILE:-${repo_root}/docker-compose.yml}"
compose_env_file="${COMPOSE_ENV_FILE:-/opt/codex-sdk-experiment/config/compose.env}"
project_name="codex-sdk-experiment"
data_dir="${DATA_DIR:-/opt/codex-sdk-experiment/data}"
archive_path="$1"

case "${data_dir}" in
  /opt/codex-sdk-experiment/data) ;;
  *)
    echo "Refusing unexpected DATA_DIR: ${data_dir}" >&2
    exit 1
    ;;
esac

case "${archive_path}" in
  /opt/codex-sdk-experiment/backups/*.tar.gz) ;;
  *)
    echo "Restore archive must be under /opt/codex-sdk-experiment/backups." >&2
    exit 1
    ;;
esac

for command_name in curl docker sqlite3 tar sha256sum; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -r "${compose_file}" || ! -r "${compose_env_file}" ]]; then
  echo "Compose file or compose environment file is not readable." >&2
  exit 1
fi

compose=(
  docker compose
  --project-name "${project_name}"
  --env-file "${compose_env_file}"
  --file "${compose_file}"
)

if [[ ! -r "${archive_path}" || ! -r "${archive_path}.sha256" ]]; then
  echo "Archive or checksum file is not readable." >&2
  exit 1
fi

(
  cd "$(dirname "${archive_path}")"
  sha256sum --check "$(basename "${archive_path}").sha256"
)

if ! tar --list --gzip --file "${archive_path}" | awk '
  /^\// { exit 1 }
  {
    count = split($0, parts, "/")
    for (index = 1; index <= count; index++) {
      if (parts[index] == "..") exit 1
    }
  }
'; then
  echo "Archive contains an unsafe path." >&2
  exit 1
fi

timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
data_parent="$(dirname "${data_dir}")"
staging_dir="${data_parent}/.restore-${timestamp}"
rollback_dir="${data_parent}/data.before-restore-${timestamp}"
failed_dir="${data_parent}/data.failed-restore-${timestamp}"
web_was_running=false
service_stopped=false
old_data_moved=false
new_data_active=false
restore_succeeded=false

if [[ -e "${staging_dir}" || -e "${rollback_dir}" || -e "${failed_dir}" ]]; then
  echo "A restore path already exists for timestamp ${timestamp}." >&2
  exit 1
fi

mkdir -m 0700 "${staging_dir}"
recover_on_exit() {
  local exit_code=$?
  trap - EXIT

  if [[ "${restore_succeeded}" != "true" ]]; then
    if [[ "${new_data_active}" == "true" ]]; then
      if [[ "${web_was_running}" == "true" ]]; then
        "${compose[@]}" stop --timeout 30 web >/dev/null 2>&1 || true
      fi
      if [[ -d "${data_dir}" ]]; then
        mv "${data_dir}" "${failed_dir}" || true
      fi
    fi

    if [[ "${old_data_moved}" == "true" \
      && -d "${rollback_dir}" \
      && ! -e "${data_dir}" ]]; then
      mv "${rollback_dir}" "${data_dir}" || true
    fi

    if [[ "${service_stopped}" == "true" \
      && "${web_was_running}" == "true" \
      && -d "${data_dir}" ]]; then
      "${compose[@]}" up --detach --no-deps web >/dev/null 2>&1 || true
    fi
  fi

  if [[ -d "${staging_dir}" ]]; then
    rm -rf -- "${staging_dir}"
  fi
  exit "${exit_code}"
}
trap recover_on_exit EXIT

tar --extract --gzip --file "${archive_path}" \
  --directory "${staging_dir}" --no-same-owner

if [[ ! -f "${staging_dir}/app.sqlite" ]]; then
  echo "The archive does not contain app.sqlite." >&2
  exit 1
fi

integrity_result="$(sqlite3 -batch -noheader "${staging_dir}/app.sqlite" \
  "PRAGMA integrity_check;")"
if [[ "${integrity_result}" != "ok" ]]; then
  echo "Restored SQLite integrity check failed." >&2
  exit 1
fi

missing_screenshot=false
while IFS= read -r screenshot_filename; do
  [[ -z "${screenshot_filename}" ]] && continue
  if [[ ! -f "${staging_dir}/screenshots/${screenshot_filename}" ]]; then
    echo "Restored screenshot is missing: ${screenshot_filename}" >&2
    missing_screenshot=true
  fi
done < <(
  sqlite3 -batch -noheader "${staging_dir}/app.sqlite" \
    "SELECT screenshot_filename
       FROM message_jobs
      WHERE screenshot_filename IS NOT NULL
      ORDER BY screenshot_filename;"
)

if [[ "${missing_screenshot}" == "true" ]]; then
  echo "Restored screenshot consistency check failed." >&2
  exit 1
fi

chown -R 1001:1001 "${staging_dir}"
find "${staging_dir}" -type d -exec chmod 0700 {} +
find "${staging_dir}" -type f -exec chmod 0600 {} +

if "${compose[@]}" ps --status running --services | grep -Fxq web; then
  web_was_running=true
  "${compose[@]}" stop --timeout 30 web
  service_stopped=true
fi

if [[ -d "${data_dir}" ]]; then
  mv "${data_dir}" "${rollback_dir}"
  old_data_moved=true
fi
mv "${staging_dir}" "${data_dir}"
new_data_active=true

if [[ "${web_was_running}" == "true" ]]; then
  if ! "${compose[@]}" up --detach --no-deps web; then
    echo "New data failed to start; rolling back." >&2
    exit 1
  fi

  healthy=false
  for _ in {1..30}; do
    if curl --fail --silent --show-error \
      "http://127.0.0.1:4310/codex-experiment/api/health" \
      | grep -q '"ok":true'; then
      healthy=true
      break
    fi
    sleep 2
  done

  if [[ "${healthy}" != "true" ]]; then
    echo "Restored service did not become healthy; rolling back." >&2
    exit 1
  fi
fi

restore_succeeded=true
echo "Restore succeeded."
if [[ -d "${rollback_dir}" ]]; then
  echo "Previous data is retained for manual cleanup: ${rollback_dir}"
fi
