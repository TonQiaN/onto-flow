#!/usr/bin/env bash
set -Eeuo pipefail

image_ref="${1:-${CODEX_EXPERIMENT_IMAGE:-}}"

if [[ -z "${image_ref}" ]]; then
  echo "CODEX_EXPERIMENT_IMAGE is required." >&2
  exit 1
fi

if [[ "${image_ref}" =~ @sha256:[0-9a-f]{64}$ \
  && ! "${image_ref}" =~ @sha256:0{64}$ ]]; then
  exit 0
fi

if [[ "${image_ref}" =~ :git-[0-9a-f]{40}$ \
  && ! "${image_ref}" =~ :git-0{40}$ ]]; then
  exit 0
fi

echo "Refusing mutable image reference: ${image_ref}" >&2
echo "Use an @sha256 digest or a unique :git-<40-character-commit-sha> tag." >&2
exit 1
