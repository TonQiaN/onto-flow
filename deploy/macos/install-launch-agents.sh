#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
Usage:
  install-launch-agents.sh --ssh-target USER@HOST --ssh-key /absolute/key/path

Installs three per-user LaunchAgents: the loopback SSH tunnel, the local Codex
worker, and daily bounded log rotation.
EOF
}

ssh_target=""
ssh_key=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-target)
      ssh_target="${2:-}"
      shift 2
      ;;
    --ssh-key)
      ssh_key="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${ssh_target}" || -z "${ssh_key}" ]]; then
  usage
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this installer as the signed-in macOS user, not root." >&2
  exit 1
fi

if [[ "${ssh_target}" == *$'\n'* || "${ssh_target}" == *[\&\<\>]* ]]; then
  echo "SSH target contains unsupported characters." >&2
  exit 1
fi

if [[ "${ssh_key}" != /* || ! -f "${ssh_key}" ]]; then
  echo "SSH key must be an existing absolute path." >&2
  exit 1
fi

key_mode="$(stat -f '%Lp' "${ssh_key}")"
if [[ "${key_mode}" != "400" && "${key_mode}" != "600" ]]; then
  echo "SSH key must have mode 0400 or 0600." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/../.." && pwd)"
node_bin="$(command -v node)"
worker_env="${project_dir}/.env.worker.local"
uid="$(id -u)"
launch_domain="gui/${uid}"
launch_dir="${HOME}/Library/LaunchAgents"
log_dir="${HOME}/Library/Logs/CodexSDKExperiment"
runtime_root="${HOME}/Library/Application Support/CodexSDKExperiment"
runtime_dir="${runtime_root}/runtime"

for value in \
  "${project_dir}" \
  "${node_bin}" \
  "${ssh_key}" \
  "${log_dir}" \
  "${runtime_dir}"; do
  if [[ "${value}" == *$'\n'* || "${value}" == *[\&\<\>]* ]]; then
    echo "A generated plist value contains unsupported characters." >&2
    exit 1
  fi
done

if [[ ! -f "${worker_env}" ]]; then
  echo "Create .env.worker.local before installing the LaunchAgents." >&2
  exit 1
fi

worker_env_mode="$(stat -f '%Lp' "${worker_env}")"
if [[ "${worker_env_mode}" != "600" ]]; then
  echo ".env.worker.local must have mode 0600." >&2
  exit 1
fi

if [[ ! -d "${project_dir}/node_modules" ]]; then
  echo "Run npm ci before installing the LaunchAgents." >&2
  exit 1
fi

if ! grep -Fxq \
  'WEB_APP_URL=http://127.0.0.1:4310/codex-experiment' \
  "${worker_env}"; then
  echo ".env.worker.local must use the loopback SSH tunnel URL." >&2
  exit 1
fi

mkdir -p "${launch_dir}" "${log_dir}" "${runtime_root}"
chmod 0700 "${log_dir}" "${runtime_root}"

runtime_staging="$(mktemp -d "${runtime_root}/.runtime-new.XXXXXX")"
cleanup_runtime_staging() {
  case "${runtime_staging}" in
    "${runtime_root}"/.runtime-new.*)
      if [[ -d "${runtime_staging}" ]]; then
        rm -rf -- "${runtime_staging}"
      fi
      ;;
  esac
}
trap cleanup_runtime_staging EXIT

for relative_path in \
  package.json \
  package-lock.json \
  tsconfig.json \
  next-env.d.ts \
  worker \
  src \
  .codex \
  node_modules; do
  ditto \
    "${project_dir}/${relative_path}" \
    "${runtime_staging}/${relative_path}"
done
install -m 0755 \
  "${script_dir}/run-worker.sh" \
  "${runtime_staging}/run-worker.sh"
install -m 0755 \
  "${script_dir}/rotate-worker-logs.sh" \
  "${runtime_staging}/rotate-worker-logs.sh"
install -m 0600 "${worker_env}" "${runtime_staging}/.env.worker.local"

if [[ -d "${runtime_dir}" ]]; then
  runtime_backup="${runtime_root}/runtime.before-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  mv "${runtime_dir}" "${runtime_backup}"
fi
mv "${runtime_staging}" "${runtime_dir}"
trap - EXIT

for log_name in \
  worker.stdout.log \
  worker.stderr.log \
  tunnel.stdout.log \
  tunnel.stderr.log; do
  touch "${log_dir}/${log_name}"
  chmod 0600 "${log_dir}/${log_name}"
done

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

escaped_project_dir="$(escape_sed_replacement "${project_dir}")"
escaped_node_bin="$(escape_sed_replacement "${node_bin}")"
escaped_ssh_key="$(escape_sed_replacement "${ssh_key}")"
escaped_ssh_target="$(escape_sed_replacement "${ssh_target}")"
escaped_log_dir="$(escape_sed_replacement "${log_dir}")"
escaped_runtime_dir="$(escape_sed_replacement "${runtime_dir}")"

render_plist() {
  local template_name="$1"
  local output_name="$2"
  local temporary_path="${launch_dir}/.${output_name}.new"
  local output_path="${launch_dir}/${output_name}"

  sed \
    -e "s/__PROJECT_DIR__/${escaped_project_dir}/g" \
    -e "s/__NODE_BIN__/${escaped_node_bin}/g" \
    -e "s/__SSH_KEY__/${escaped_ssh_key}/g" \
    -e "s/__SSH_TARGET__/${escaped_ssh_target}/g" \
    -e "s/__LOG_DIR__/${escaped_log_dir}/g" \
    -e "s/__RUNTIME_DIR__/${escaped_runtime_dir}/g" \
    "${script_dir}/${template_name}" > "${temporary_path}"
  plutil -lint "${temporary_path}" >/dev/null

  if [[ -f "${output_path}" ]]; then
    mv "${output_path}" "${output_path}.before-$(date -u '+%Y%m%dT%H%M%SZ')"
  fi
  mv "${temporary_path}" "${output_path}"
  chmod 0600 "${output_path}"
}

render_plist \
  com.codex-sdk-experiment.tunnel.plist.template \
  com.codex-sdk-experiment.tunnel.plist
render_plist \
  com.codex-sdk-experiment.worker.plist.template \
  com.codex-sdk-experiment.worker.plist
render_plist \
  com.codex-sdk-experiment.maintenance.plist.template \
  com.codex-sdk-experiment.maintenance.plist

for label in \
  com.codex-sdk-experiment.worker \
  com.codex-sdk-experiment.tunnel \
  com.codex-sdk-experiment.maintenance; do
  launchctl bootout "${launch_domain}/${label}" >/dev/null 2>&1 || true
done

bootstrap_launch_agent() {
  local label="$1"
  local attempt

  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap \
      "${launch_domain}" \
      "${launch_dir}/${label}.plist"; then
      return 0
    fi
    if launchctl print "${launch_domain}/${label}" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "${attempt}" -lt 5 ]]; then
      sleep 1
    fi
  done

  echo "Unable to bootstrap ${label} after five attempts." >&2
  return 1
}

for label in \
  com.codex-sdk-experiment.tunnel \
  com.codex-sdk-experiment.worker \
  com.codex-sdk-experiment.maintenance; do
  bootstrap_launch_agent "${label}"
  launchctl enable "${launch_domain}/${label}"
done

launchctl kickstart -k \
  "${launch_domain}/com.codex-sdk-experiment.tunnel"
launchctl kickstart -k \
  "${launch_domain}/com.codex-sdk-experiment.worker"

echo "LaunchAgents installed for the current Aqua login session."
echo "Web URL: http://127.0.0.1:4310/codex-experiment"
