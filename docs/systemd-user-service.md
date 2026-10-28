# Persistent Codex WebUI user service

The Agent Command Center and passive niri overlay use Codex WebUI as their local agent-state bridge.
Install it as a systemd user service so it starts with the user session and returns automatically
after a process failure. No browser window needs to remain open.

The service deliberately runs the stable launcher at `/home/hashed/bin/codex-webui`. That launcher
selects the canonical checkout at `/home/hashed/git/codex-webui`, binds only to
`http://127.0.0.1:19889`, and does not fetch from the network during startup.

## Install or update

From the canonical checkout, run:

```bash
cd /home/hashed/git/codex-webui
scripts/install-systemd-user-service
```

The installer is repeatable. Each run copies the repository-owned unit into the user systemd
configuration, reloads the user manager, enables startup, and restarts the service so a newly pulled
version takes effect immediately.

The service starts at user login. It does not require system-wide root access. Keeping it alive after
all user sessions have ended would additionally require systemd user lingering; that is not needed
for the desktop and overlay use case.

## Operations

```bash
systemctl --user status codex-webui.service
systemctl --user restart codex-webui.service
journalctl --user -u codex-webui.service -f
```

The service uses `Restart=on-failure`: crashes are retried after two seconds, while an intentional
`systemctl --user stop codex-webui.service` remains stopped.

To disable persistent startup and stop the service:

```bash
systemctl --user disable --now codex-webui.service
```

The installed unit remains in `~/.config/systemd/user/` so it can be enabled again. Remove that file
and run `systemctl --user daemon-reload` only when uninstalling the integration completely.
