# Codex SDK WeLink Experiment

This private experiment lets an authenticated web user enqueue a WeLink
message. The system deliberately separates the web control plane from desktop
automation:

- Tencent Cloud runs only the Next.js web service and its SQLite database.
- A signed-in macOS GUI session runs the local `@openai/codex-sdk` worker,
  Computer Use, and WeLink.
- The first release has no public HTTP endpoint. Both the browser and worker
  reach Tencent Cloud through `127.0.0.1:4310` and an SSH tunnel.

The cloud container never receives the raw worker token, Codex login, or WeLink
login. The Mac never receives the administrator password hash or cloud
database.

For the first end-to-end experiment, the recipient allowlist contains only
`付方圆`, and the page is prefilled with `这是一条测试消息`. This keeps the
real-message acceptance test bounded; extend the allowlist only after adding
and verifying another exact WeLink identity.

## Local development

Requirements are Node.js 22 or newer, a signed-in Codex installation, and a
signed-in WeLink desktop app.

```bash
npm ci
npm run setup:local
npm run dev
```

Open `http://127.0.0.1:3000/login`. Local administrator credentials are written
to the ignored `.data/admin-credentials.txt` file. Only start `npm run worker`
when a real queued job is intentionally ready for execution.

Before publishing, run:

```bash
npm run check
```

## Deployment and operations

Detailed instructions are in [deploy/README.md](deploy/README.md):

- immutable Linux image build and Tencent Cloud release;
- loopback-only Compose service and macOS SSH-tunnel LaunchAgents;
- consistent SQLite plus screenshot backup and restore;
- log rotation, retention, rollback, and production acceptance.

No Nginx configuration is used in the first release. Port `4310` is bound only
to the Tencent host's loopback interface.
