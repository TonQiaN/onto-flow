#!/bin/zsh
set -euo pipefail

project_dir="${CODEX_EXPERIMENT_PROJECT_DIR:?Missing project directory}"
log_dir="${project_dir}/.data/logs"
max_bytes="${WORKER_LOG_MAX_BYTES:-10485760}"
keep_files="${WORKER_LOG_KEEP_FILES:-5}"
worker_label="com.codex-sdk-experiment.worker"
rotated=false

if [[ ! "${max_bytes}" =~ ^[0-9]+$ ]] || (( max_bytes < 1048576 )); then
  echo "WORKER_LOG_MAX_BYTES must be at least 1048576." >&2
  exit 1
fi

if [[ ! "${keep_files}" =~ ^[0-9]+$ ]] \
  || (( keep_files < 1 || keep_files > 20 )); then
  echo "WORKER_LOG_KEEP_FILES must be from 1 through 20." >&2
  exit 1
fi

mkdir -p "${log_dir}"
chmod 0700 "${log_dir}"

rotate_one() {
  local log_path="$1"
  local size=0
  local index

  [[ -f "${log_path}" ]] || return 0
  size="$(stat -f '%z' "${log_path}")"
  (( size >= max_bytes )) || return 0

  rm -f -- "${log_path}.${keep_files}"
  for (( index = keep_files - 1; index >= 1; index-- )); do
    if [[ -f "${log_path}.${index}" ]]; then
      mv -- "${log_path}.${index}" "${log_path}.$((index + 1))"
    fi
  done
  mv -- "${log_path}" "${log_path}.1"
  : > "${log_path}"
  chmod 0600 "${log_path}" "${log_path}.1"
  rotated=true
}

rotate_one "${log_dir}/worker.stdout.log"
rotate_one "${log_dir}/worker.stderr.log"
rotate_one "${log_dir}/tunnel.stdout.log"
rotate_one "${log_dir}/tunnel.stderr.log"

if [[ "${rotated}" == "true" ]]; then
  launchctl kickstart -k \
    "gui/$(id -u)/com.codex-sdk-experiment.tunnel" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/${worker_label}" >/dev/null 2>&1 || true
fi
