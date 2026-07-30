# Deployment and operations

## Public browser and private worker boundary

The browser uses a dedicated HTTPS hostname while the desktop worker remains
on the private SSH tunnel:

```text
Public browser ─ HTTPS :443 ─ Caddy edge ─ web container
                                           │
Mac worker ─ 127.0.0.1:4310 ─ SSH ─ Tencent 127.0.0.1:4310
                                           │
                                   SQLite + screenshots

Mac GUI session: Codex login + Computer Use + WeLink login
Tencent Cloud:   Caddy + Next.js + worker-token digest + SQLite
```

The public endpoint is
`https://codex.82.156.249.86.nip.io/codex-experiment`. Caddy obtains and renews
the certificate and overwrites `X-Real-IP` before forwarding. There is still no
listener on `0.0.0.0:4310`; do not open TCP `4310` in a Tencent security group.
The raw worker API stays behind the SSH tunnel.

The cloud must never run `npm run worker`; Computer Use requires the signed-in
Mac Aqua session. The cloud stores only `WORKER_TOKEN_SHA256`, while the raw
`WORKER_TOKEN`, `CODEX_HOME`, Codex session, and WeLink session stay on the Mac.

## Server layout

Use these exact paths:

```text
/opt/codex-sdk-experiment/
  release/       committed docker-compose.yml and deploy/ files
  config/
    app.env      web secrets, mode 0600
    compose.env  immutable image reference, mode 0600
  data/          app.sqlite and screenshots/, owned by uid/gid 1001
  backups/       cold archives and checksums, mode 0700
  images/        transferred image archives
```

The server needs Docker Engine, Docker Compose v2, `curl`, `sqlite3`, `tar`, and
`sha256sum`. Public TCP `443` must reach the host. Port `80` can remain assigned
to the existing service because this Caddy instance disables HTTP redirects
and completes certificate validation on `443`.

## Build an immutable image

Do this only from a clean, committed `codex/` branch after `npm run check`
passes:

```bash
test -z "$(git status --porcelain)"
git_sha="$(git rev-parse HEAD)"
image_ref="codex-sdk-experiment:git-${git_sha}"
docker buildx build \
  --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_BASE_PATH=/codex-experiment \
  --tag "${image_ref}" \
  --load \
  .
mkdir -p output
docker image save "${image_ref}" | gzip > "output/codex-sdk-experiment-git-${git_sha}.tar.gz"
(
  cd output
  shasum -a 256 "codex-sdk-experiment-git-${git_sha}.tar.gz" \
    > "codex-sdk-experiment-git-${git_sha}.tar.gz.sha256"
)
```

Every image tag contains the full 40-character commit SHA. Never use `latest`
and never retag an existing `git-...` release. A registry digest ending in
`@sha256:<64 hex characters>` is also accepted.

Transfer the image archive, checksum, `docker-compose.yml`, and `deploy/` to
the server's `images/` and `release/` directories over SSH. Verify the archive
checksum before `docker load`. Keep the previous image and tag for rollback.

On the server, for the chosen archive:

```bash
cd /opt/codex-sdk-experiment/images
sha256sum --check codex-sdk-experiment-git-<40-sha>.tar.gz.sha256
gzip --decompress --stdout codex-sdk-experiment-git-<40-sha>.tar.gz \
  | sudo docker image load
```

## Configure Tencent Cloud

Create the directories once:

```bash
sudo install -d -m 0755 /opt/codex-sdk-experiment/release
sudo install -d -m 0700 /opt/codex-sdk-experiment/config
sudo install -d -m 0700 /opt/codex-sdk-experiment/backups
sudo install -d -m 0700 -o 1001 -g 1001 /opt/codex-sdk-experiment/data
sudo install -d -m 0755 /opt/codex-sdk-experiment/images
```

Copy `.env.example` to
`/opt/codex-sdk-experiment/config/app.env`, fill real values, and set mode
`0600`. Its public URL values must be:

```dotenv
PUBLIC_APP_URL=https://codex.82.156.249.86.nip.io/codex-experiment
SESSION_COOKIE_SECURE=true
TRUST_PROXY_HEADERS=true
TRUSTED_ORIGINS=https://codex.82.156.249.86.nip.io
```

Only the SHA-256 digest of the worker token belongs in `app.env`. Copy
`deploy/compose.env.example` to `config/compose.env`, replace the web image
value with the exact image tag loaded on the server, keep the pinned Caddy
digest and public hostname, and set mode `0600`.

Validate before starting:

```bash
cd /opt/codex-sdk-experiment/release
image_ref="$(sed -n 's/^CODEX_EXPERIMENT_IMAGE=//p' ../config/compose.env)"
deploy/scripts/validate-image-ref.sh "${image_ref}"
docker compose \
  --project-name codex-sdk-experiment \
  --env-file ../config/compose.env \
  --file docker-compose.yml \
  config --quiet
```

The Compose project name is fixed as `codex-sdk-experiment`. The web service runs
as uid/gid `1001`, drops all Linux capabilities, uses a read-only root
filesystem and bounded tmpfs, has CPU/memory/PID limits, rotates five 10 MB
Docker log files, and publishes only `127.0.0.1:4310`. The Caddy edge publishes
only HTTPS `443`, uses persistent certificate/config volumes, and cannot access
the host's loopback worker port.

## Release and rollback

Before upgrading an existing installation, make a consistent backup:

```bash
sudo /opt/codex-sdk-experiment/release/deploy/scripts/backup.sh
```

Load the verified image, set its unique reference in `config/compose.env`, then:

```bash
cd /opt/codex-sdk-experiment/release
sudo docker compose \
  --project-name codex-sdk-experiment \
  --env-file ../config/compose.env \
  --file docker-compose.yml \
  up --detach --no-build web edge
sudo deploy/scripts/verify-runtime.sh
```

For an application-only rollback, restore the previous image reference in
`compose.env` and run the same `up --detach --no-build web` command. If a
release changed persistent data incompatibly, restore the backup that was
created immediately before that release; see
[BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## macOS SSH tunnel and GUI worker

First copy `.env.worker.example` to `.env.worker.local`, fill the raw worker
token, keep
`WEB_APP_URL=http://127.0.0.1:4310/codex-experiment`, and set mode `0600`.
The worker starts a fresh Codex thread for every job; only that job's preflight
and send turns share context.

Before installing the LaunchAgents, establish the host key and prove that SSH
authentication works without a prompt:

```bash
ssh -i /absolute/path/to/key USER@TENCENT_HOST true
ssh -o BatchMode=yes -i /absolute/path/to/key USER@TENCENT_HOST true
```

Then run, as the signed-in macOS user:

```bash
deploy/macos/install-launch-agents.sh \
  --ssh-target USER@TENCENT_HOST \
  --ssh-key /absolute/path/to/key
```

This installs:

- `com.codex-sdk-experiment.tunnel`: persistent loopback SSH forwarding;
- `com.codex-sdk-experiment.worker`: local Node/Codex worker in the Aqua login
  session, running from a private mirror under
  `~/Library/Application Support/CodexSDKExperiment/runtime`;
- `com.codex-sdk-experiment.maintenance`: daily bounded log rotation.

The worker and tunnel restart on failure. Logs remain under
`~/Library/Logs/CodexSDKExperiment`, rotate at 10 MB, and retain five files. Check them without
printing environment files or tokens:

```bash
deploy/macos/status.sh
launchctl print "gui/$(id -u)/com.codex-sdk-experiment.worker"
```

## Automated backup

Copy the two files under `deploy/systemd/` to `/etc/systemd/system/`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-sdk-experiment-backup.timer
sudo systemctl list-timers codex-sdk-experiment-backup.timer
```

The timer takes a short cold backup every day: it stops the web container,
checks SQLite and all database-referenced screenshots, archives the whole data
directory, writes a checksum and image metadata, then restores the prior
running state. Backups are mode `0600` under a mode `0700` directory and are
retained for 30 days.

These archives contain message data and screenshots. Copy them off-host only
through an encrypted channel and place them in encrypted storage.

## Production acceptance

On Tencent Cloud:

```bash
cd /opt/codex-sdk-experiment/release
sudo deploy/scripts/verify-runtime.sh
sudo docker compose \
  --project-name codex-sdk-experiment \
  --env-file ../config/compose.env \
  --file docker-compose.yml \
  ps
```

On the Mac:

```bash
deploy/macos/status.sh
curl --fail http://127.0.0.1:4310/codex-experiment/api/health
```

Also verify from a separate network that the HTTPS endpoint is reachable, an
unauthenticated console request redirects to login, and
`TENCENT_PUBLIC_IP:4310` remains unreachable. UI acceptance must use the in-app
Browser plugin. A message test is accepted only when the queued job reaches
success and a fresh WeLink screenshot visibly shows the exact recipient and
message. An uncertain send must remain for manual review and must never be
retried automatically. After an independent WeLink check, resolving it as sent
requires uploading that fresh PNG/JPEG evidence; the server decodes, bounds,
strips metadata from, and re-encodes the image before attaching it to the
terminal job.
