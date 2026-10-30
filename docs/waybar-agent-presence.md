# Waybar agent presence

`scripts/waybar-agent-presence.ts` turns the local presence snapshot into one Waybar custom-module
update. It follows the installed `waybar-custom(5)` JSON contract and emits `text`, `tooltip`, and a
CSS `class` array.

The compact text shows working and attention counts. The tooltip lists tasks that need attention
before tasks that are still working. Completed, failed, and interrupted rows are attention items
while they remain in the server's recent-task snapshot; hierarchy-only ancestor rows are excluded.

Example Waybar module configuration:

```jsonc
"custom/codex-agents": {
  "exec": "/home/hashed/git/codex-webui/scripts/waybar-agent-presence.ts",
  "return-type": "json",
  "interval": 2,
  "tooltip": true
}
```

The output gets one of `waiting`, `working`, or `idle`. A stale successful snapshot additionally gets
`stale`; a transport, `curl`, or JSON failure gets `offline` and still produces valid Waybar JSON.

The endpoint defaults to `http://127.0.0.1:19889/api/agents/snapshot`. Override it for testing or a
non-default local deployment with `CODEX_WAYBAR_AGENT_ENDPOINT`; change the curl timeout with
`CODEX_WAYBAR_AGENT_TIMEOUT` (seconds).
