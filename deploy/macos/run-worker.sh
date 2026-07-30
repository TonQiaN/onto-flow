#!/bin/zsh
set -euo pipefail

project_dir="${CODEX_EXPERIMENT_PROJECT_DIR:?Missing project directory}"
node_bin="${CODEX_EXPERIMENT_NODE_BIN:?Missing Node.js path}"
worker_env="${project_dir}/.env.worker.local"

if [[ ! -x "${node_bin}" ]]; then
  echo "Configured Node.js binary is not executable." >&2
  exit 1
fi

if [[ ! -f "${worker_env}" ]]; then
  echo ".env.worker.local is missing." >&2
  exit 1
fi

env_mode="$(stat -f '%Lp' "${worker_env}")"
if [[ "${env_mode}" != "600" ]]; then
  echo ".env.worker.local must have mode 0600." >&2
  exit 1
fi

cd "${project_dir}"
exec "${node_bin}" \
  --env-file="${worker_env}" \
  --import tsx \
  worker/index.ts
