# Passive agent overlay on niri

The native overlay is a resident, display-only companion to Agent Command Center. It reads the
redacted local snapshot from Codex WebUI, renders the project/agent/subagent tree, and reconnects
when the WebUI restarts. Its Wayland surface does not request keyboard focus and has no pointer or
touch input region.

This first slice deliberately has no agent input, resume action, voice, or push-to-talk.

## Install and build

The overlay uses a repository-local installation: keep the canonical checkout at
`/home/hashed/git/codex-webui` and build the release binary there. Nothing needs to be copied into
`/usr` or `~/.local`. Codex WebUI should run continuously through the
[systemd user service](./systemd-user-service.md); the overlay reconnects automatically while that
service restarts.

Build the binary once, and rebuild it after overlay source changes:

```bash
cd /home/hashed/git/codex-webui
cargo build --release --manifest-path overlay/Cargo.toml
```

The repository-owned `scripts/agent-overlay` launcher resolves the release binary relative to its
own checkout. This keeps the niri configuration stable across rebuilds. Set
`CODEX_AGENT_OVERLAY_BIN` only when you intentionally want the launcher to use another binary.

The overlay expects Codex WebUI at `http://127.0.0.1:19889/api/agents/snapshot`. Set
`CODEX_OVERLAY_ENDPOINT` to override that URL. Control commands use
`$XDG_RUNTIME_DIR/codex-agent-overlay.sock`; set `CODEX_OVERLAY_SOCKET` to override the socket.
The resident keeps running and shows an offline/stale state when WebUI is unavailable.

## Start and toggle from niri

Copy the two nodes from [`niri-agent-overlay.kdl`](./niri-agent-overlay.kdl) into the corresponding
top level and `binds` block of `~/.config/niri/config.kdl`:

```kdl
spawn-at-startup "/home/hashed/git/codex-webui/scripts/agent-overlay"

binds {
    Mod+Shift+A allow-inhibiting=false {
        spawn "/home/hashed/git/codex-webui/scripts/agent-overlay" "toggle"
    }
}
```

If a `binds` block already exists, add only the `Mod+Shift+A` entry to it. Do not add a second
`binds` block. The `allow-inhibiting=false` property makes the toggle available even when a game
has activated the keyboard-shortcuts inhibitor. Change the key chord if it conflicts with an
existing binding.

`spawn-at-startup` starts the resident on the next niri session. After editing the config, validate
it before reloading:

```bash
niri validate -c ~/.config/niri/config.kdl
```

The same controls are available from a terminal without restarting the resident:

```bash
scripts/agent-overlay toggle
scripts/agent-overlay show
scripts/agent-overlay hide
scripts/agent-overlay status
```

Running `scripts/agent-overlay` without a subcommand starts the resident in the foreground.
`scripts/agent-overlay --hidden` starts it hidden. The resident also accepts `--endpoint URL` and
`--socket PATH`.

## Deferred acceptance check

Repository checks can validate the build, launcher, and niri syntax without a compositor session.
The actual acceptance check is intentionally deferred until a niri session is available: start a
fullscreen game, toggle the overlay repeatedly, and confirm that it stays above the game without
moving focus or receiving pointer, touch, or keyboard input.
