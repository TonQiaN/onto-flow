# macOS LaunchAgents

These LaunchAgents must be installed by the signed-in desktop user. A LaunchDaemon
or cloud-side worker is intentionally unsupported because Codex Computer Use
and WeLink need the user's Aqua GUI session.

Prerequisites:

- `.env.worker.local` exists, has mode `0600`, and uses the loopback URL;
- Node.js 22+ and project dependencies are installed;
- Codex and WeLink are signed in for the same macOS user;
- the SSH host key has already been accepted interactively;
- the selected SSH key works with `BatchMode=yes`.

Install:

```bash
deploy/macos/install-launch-agents.sh \
  --ssh-target USER@TENCENT_HOST \
  --ssh-key /absolute/path/to/key
```

Inspect:

```bash
deploy/macos/status.sh
launchctl print "gui/$(id -u)/com.codex-sdk-experiment.tunnel"
launchctl print "gui/$(id -u)/com.codex-sdk-experiment.worker"
```

Stop without deleting files:

```bash
launchctl bootout \
  "gui/$(id -u)/com.codex-sdk-experiment.worker"
launchctl bootout \
  "gui/$(id -u)/com.codex-sdk-experiment.tunnel"
launchctl bootout \
  "gui/$(id -u)/com.codex-sdk-experiment.maintenance"
```

The installer backs up an existing plist with a UTC timestamp before replacing
it. Generated plists contain paths and the SSH target, but no token, Codex
credential, administrator password, or message content.

LaunchAgent stdout and stderr are written under
`~/Library/Logs/CodexSDKExperiment`, not under the project on Desktop. This
keeps log-file creation outside macOS protected Desktop folders.

The installer also creates a private runtime mirror under
`~/Library/Application Support/CodexSDKExperiment/runtime`. It contains only
the local Worker source, dependencies, WeLink skill, and a `0600` copy of the
Worker environment. LaunchAgent processes run from that mirror because macOS
background services cannot read a project stored in the protected Desktop
folder. Re-running the installer replaces the runtime atomically and preserves
the previous runtime in a timestamped sibling directory.
