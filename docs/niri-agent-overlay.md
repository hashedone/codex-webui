# Passive agent overlay on niri

The native overlay is a resident, display-only companion to Agent Command Center. It reads the
redacted local snapshot from Codex WebUI, renders the project/agent/subagent tree, and reconnects
when the WebUI restarts. Root threads receive stable slots `[1]` through `[9]`; descendants remain
nested beneath their root. Its Wayland surface does not request keyboard focus and has no pointer or
touch input region.

The overlay can read deterministic Polish status summaries through a local TTS process. It still has
no agent input, resume action, recording, transcription, or push-to-talk.

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
Slot assignments persist in `$XDG_STATE_HOME/codex-webui/agent-overlay-slots.json` (or
`~/.local/state/codex-webui/agent-overlay-slots.json`); set `CODEX_OVERLAY_SLOTS` to override it.
The resident keeps running and shows an offline/stale state when WebUI is unavailable.

Speech defaults to `spd-say -l pl`. Set `CODEX_OVERLAY_TTS_LOCALE` to change the locale,
`CODEX_OVERLAY_TTS_BACKEND=espeak-ng` to use eSpeak NG, or the backend to `disabled` to turn speech
off. Speech is launched without a shell. A newer read command cancels and replaces the previous one.

## Start and toggle from niri

Copy the two nodes from [`niri-agent-overlay.kdl`](./niri-agent-overlay.kdl) into the corresponding
top level and `binds` block of `~/.config/niri/config.kdl`:

```kdl
spawn-at-startup "/home/hashed/git/codex-webui/scripts/agent-overlay" "--hidden"

binds {
    Mod+A repeat=false allow-inhibiting=false {
        spawn "/home/hashed/git/codex-webui/scripts/agent-overlay" "toggle"
    }
    Mod+S repeat=false allow-inhibiting=false {
        spawn "/home/hashed/git/codex-webui/scripts/agent-overlay" "read-summary"
    }
    Mod+1 repeat=false allow-inhibiting=false {
        spawn "/home/hashed/git/codex-webui/scripts/agent-overlay" "read-slot" "1"
    }
    // Repeat the same pattern for Mod+2 through Mod+9.
}
```

If a `binds` block already exists, add only these entries to it. Do not add a second
`binds` block. The `repeat=false` property ensures one key press produces exactly one toggle, while
`allow-inhibiting=false` keeps the toggle available even when a game has activated the
keyboard-shortcuts inhibitor. Change the key chord if it conflicts with an existing binding.

`spawn-at-startup` starts the resident hidden on the next niri session; `Mod+A` reveals it on demand.
`Mod+1` through `Mod+9` read the matching root and visible descendants. `Mod+S` reads a compact
summary of every occupied slot in numeric order. Status or snapshot-order changes never move a
thread, and assignments survive overlay restarts. A new root takes the lowest unused slot; only when
all nine are reserved may the oldest absent root's slot be reused.
After editing the config, validate it before reloading:

```bash
niri validate -c ~/.config/niri/config.kdl
```

The same controls are available from a terminal without restarting the resident:

```bash
scripts/agent-overlay toggle
scripts/agent-overlay show
scripts/agent-overlay hide
scripts/agent-overlay status
scripts/agent-overlay read-slot 1
scripts/agent-overlay read-summary
```

Running `scripts/agent-overlay` without a subcommand starts the resident in the foreground.
`scripts/agent-overlay --hidden` starts it hidden. The resident also accepts `--endpoint URL` and
`--socket PATH`.

## Deferred acceptance check

Repository checks can validate the build, launcher, and niri syntax without a compositor session.
The actual acceptance check is intentionally deferred until a niri session is available: start a
fullscreen game, toggle the overlay repeatedly, and confirm that it stays above the game without
moving focus or receiving pointer, touch, or keyboard input.
