# Backup and restore

## Consistency model

SQLite runs in WAL mode and screenshot files are referenced by database rows.
Copying either while the web service is writing can produce a mismatched
backup. `deploy/scripts/backup.sh` therefore performs a short cold backup:

1. record whether the web service is running;
2. stop it gracefully so SQLite closes and checkpoints;
3. run `PRAGMA integrity_check`;
4. ensure every `screenshot_filename` referenced by the database exists;
5. archive the entire data directory and write SHA-256 plus image metadata;
6. restart the service only if it was running before the backup.

The default daily timer retains 30 days. `RETENTION_DAYS` may be set from 7
through 365. Retention deletes only matching backup artifacts inside
`/opt/codex-sdk-experiment/backups`.

## Manual backup

```bash
sudo /opt/codex-sdk-experiment/release/deploy/scripts/backup.sh
```

A successful run produces three files:

```text
codex-sdk-experiment-<UTC timestamp>.tar.gz
codex-sdk-experiment-<UTC timestamp>.tar.gz.sha256
codex-sdk-experiment-<UTC timestamp>.tar.gz.metadata
```

Copy all three to encrypted off-host storage. Periodically restore a copy into
a non-production test host; an untested backup is not a recovery plan.

## Restore

Choose the archive deliberately. The restore script accepts only an absolute
archive path under `/opt/codex-sdk-experiment/backups`:

```bash
sudo /opt/codex-sdk-experiment/release/deploy/scripts/restore.sh \
  /opt/codex-sdk-experiment/backups/codex-sdk-experiment-YYYYMMDDTHHMMSSZ.tar.gz
```

The script verifies the checksum, rejects unsafe archive paths, stages the
files, checks SQLite and screenshot references, stops the service, and swaps
the data directory. If startup or health verification fails, it automatically
puts back the previous data directory.

On success, the previous data remains at a timestamped path such as:

```text
/opt/codex-sdk-experiment/data.before-restore-YYYYMMDDTHHMMSSZ
```

Keep that directory until functional acceptance is complete. Remove it only
after a human confirms the restored task history and screenshots. A failed
candidate is likewise retained as `data.failed-restore-<timestamp>` for
diagnosis.

## Post-restore acceptance

```bash
sudo /opt/codex-sdk-experiment/release/deploy/scripts/verify-runtime.sh
sudo sqlite3 /opt/codex-sdk-experiment/data/app.sqlite \
  'PRAGMA integrity_check;'
```

Then use the Mac SSH tunnel and in-app Browser to verify login, historical task
rows, and screenshot retrieval. Do not enqueue a new WeLink message merely to
test database restoration.
