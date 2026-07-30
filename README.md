# Codex SDK WeLink Experiment

This private experiment lets an authenticated web user enqueue a WeLink
message. The system deliberately separates the web control plane from desktop
automation:

- Tencent Cloud runs only the Next.js web service and its SQLite database.
- A signed-in macOS GUI session runs the local `@openai/codex-sdk` worker,
  Computer Use, and WeLink.
- Browser traffic reaches Tencent Cloud through an authenticated HTTPS
  endpoint. The worker continues to use `127.0.0.1:4310` through an SSH tunnel,
  so its bearer token and desktop automation channel are not publicly exposed.

The cloud container never receives the raw worker token, Codex login, or WeLink
login. The Mac never receives the administrator password hash or cloud
database.

The recipient allowlist contains the exact WeLink identities `付方圆` and
`成雨函`, while the page remains prefilled with `付方圆` and
`这是一条测试消息`. Only `付方圆` has been authorized for real-message
acceptance tests so far; `成雨函` is selectable but must not be used for a real
send until a separate test is explicitly requested.

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
- HTTPS Caddy edge plus a loopback-only worker API tunnel;
- consistent SQLite plus screenshot backup and restore;
- log rotation, retention, rollback, and production acceptance.

No shared Nginx configuration is modified. Public browser traffic uses the
dedicated HTTPS hostname, while port `4310` remains bound only to the Tencent
host's loopback interface.
