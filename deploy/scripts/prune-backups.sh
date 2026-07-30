#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

backup_dir="${BACKUP_DIR:-/opt/codex-sdk-experiment/backups}"
retention_days="${RETENTION_DAYS:-30}"

case "${backup_dir}" in
  /opt/codex-sdk-experiment/backups | /opt/codex-sdk-experiment/backups/*) ;;
  *)
    echo "Refusing unexpected BACKUP_DIR: ${backup_dir}" >&2
    exit 1
    ;;
esac

if [[ ! "${retention_days}" =~ ^[0-9]+$ ]] \
  || (( retention_days < 7 || retention_days > 365 )); then
  echo "RETENTION_DAYS must be an integer from 7 through 365." >&2
  exit 1
fi

if [[ ! -d "${backup_dir}" ]]; then
  exit 0
fi

find "${backup_dir}" -maxdepth 1 -type f \
  \( -name 'codex-sdk-experiment-*.tar.gz' \
     -o -name 'codex-sdk-experiment-*.tar.gz.sha256' \
     -o -name 'codex-sdk-experiment-*.tar.gz.metadata' \) \
  -mtime "+${retention_days}" -delete
