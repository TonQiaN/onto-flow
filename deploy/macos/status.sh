#!/usr/bin/env bash
set -Eeuo pipefail

launch_domain="gui/$(id -u)"
failed=false

for label in \
  com.codex-sdk-experiment.tunnel \
  com.codex-sdk-experiment.worker \
  com.codex-sdk-experiment.maintenance; do
  if launchctl print "${launch_domain}/${label}" >/dev/null 2>&1; then
    echo "${label}: loaded"
  else
    echo "${label}: not loaded" >&2
    failed=true
  fi
done

if ! curl --fail --silent --show-error \
  "http://127.0.0.1:4310/codex-experiment/api/health" \
  | grep -q '"ok":true'; then
  echo "Loopback health check failed." >&2
  failed=true
else
  echo "Loopback health check: passed"
fi

if [[ "${failed}" == "true" ]]; then
  exit 1
fi
