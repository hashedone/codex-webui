# Web agent command center

Tracker: [#4](https://github.com/hashedone/codex-webui/issues/4). Based on the open safe-local-pilot [PR #2](https://github.com/hashedone/codex-webui/pull/2), commit `b94da1b`. Feature branch: `feat/web-agent-command-center`; PR target: `fix/1-safe-local-pilot`, not `main`.

## Use

Start this feature worktree with `HOST=127.0.0.1 PORT=19889 bun run start`, then open `http://127.0.0.1:19889/?view=agents` or choose **Agent command center** in the sidebar. Use a different loopback port if the existing pilot is running. The installed `codex-webui` launcher still points to the original pilot worktree; this change does not replace it.

The overview shows roots and protocol-exposed descendants, ancestry, runtime state, last meaningful activity, workspace, direct-input capability, and **Open task**. Search retains parent context. The active filter retains ancestors of matching active tasks. Internal agents with explicit `canAcceptDirectInput: false` can be inspected but the composer refuses direct input. Unknown capabilities remain unknown.

## Ownership boundary

This MVP observes the WebUI's existing child `codex app-server --stdio`. It does not attach to Codex Desktop, start a daemon, read arbitrary session files for inventory, or acquire external writers. The browser is independent of the terminal, but the dashboard must own the app-server. Multiple browser tabs share that server and its overview.

Inventory starts with `thread/loaded/list`, pages metadata reads, and queries descendants with `thread/list` and `ancestorThreadId`. Every installed `ThreadSourceKind` is requested explicitly because the default list filter excludes noninteractive sources. Previously observed tasks remain visible as unloaded until archive/delete or app-server restart. Ownership memory is reset on every process restart; historical tasks appear again only when loaded on this server or returned through explicit ancestry. It is not a global history browser. If the protocol omits a descendant or ancestry, the UI cannot reconstruct it. `forkedFromId` is not treated as a parent.

Do not infer ownership from `source`, `originator`, cwd, or shared files. An isolated test thread created through our own app-server returned `source: vscode` and `originator: Codex Desktop`; those values are not proof of Desktop ownership or access.

The prior 2026-10-19 spike rejected external resume with an active-writer conflict even while the Desktop thread was idle. On 2026-10-26, `codex app-server daemon version` still failed because `/home/hashed/.codex/app-server-control/app-server-control.sock` did not exist. No new Desktop takeover was attempted or claimed.

## Verified protocol and CLI comparison

Sources checked on 2026-10-26:

- [Official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server), including loaded inventory, runtime status, experimental ancestry filters and pagination.
- [Official developer commands](https://learn.chatgpt.com/docs/developer-commands).
- Installed `codex --version`: **codex-cli 0.154.0**; `codex agents --help`; `codex app-server --help`; `codex app-server generate-ts --help`.
- `codex app-server generate-ts --experimental --out /tmp/codex-command-center-schema`: inspected `Thread`, `ThreadStatus`, `ThreadActiveFlag`, `ThreadListParams`, `ThreadLoadedListParams/Response`, `ThreadSourceKind`, `SessionSource`, `SubAgentSource`, `ThreadReadParams`, and lifecycle notifications. Generated files are disposable evidence, not checked-in bindings.
- Real 0.154.0 protocol probes used isolated temporary Codex homes and empty threads, with **zero model turns**. No tests mutated Desktop tasks.

The installed `codex agents --remote ws://127.0.0.1:19934 --no-alt-screen` was exercised against a disposable loopback server. Temporary dummy authentication was used solely to get past onboarding; no real credentials or model calls were used. Observed UI:

| Surface | Installed `codex agents` | WebUI MVP |
| --- | --- | --- |
| Ownership | Shared local daemon by default; explicit remote endpoint supported | Existing dashboard-owned stdio server only |
| Summary | Need-input / working / ready counts | Active / root / descendant counts; explicit runtime states |
| Task list | Workspace grouping, title, Ready state for the empty idle probe | Parent tree, workspace, status, activity, input capability |
| Controls | New task, search, grouping, rename, stop, open/resume shortcuts | Search/filter/refresh/open; creation and input remain in the existing chat |
| Open | Enter attempted `thread/resume`; empty probe failed with no rollout found | Read-only history request, with metadata fallback if unsupported; no resume for opening |
| Descendants | Not exercised with real model delegation in this probe | Generated-schema contract plus deterministic multilevel fixtures; actual ancestry query succeeded with an empty result |

The CLI also displayed Finished after the empty probe attach/interrupt sequence; this is not evidence that `idle` means completed. The web view deliberately reports the runtime status directly. No parity claim is made for all CLI grouping, completion heuristics, or internal-agent presentation.

The local 0.154.0 backend returned **`list_turns is not supported yet`** for `thread/read` with `includeTurns: true`, despite advertising the schema. Opening falls back to a metadata read and visibly reports the history error. A supported backend still renders the existing conversation history. This smoke test does not establish full transcript support on the installed backend or validate a real model-generated delegation tree.

## Refresh, classification, and security

`host/agents/list` is a read-only bridge method behind the same HTTP/WS authentication and origin checks. It projects allowlisted summary fields only. It neither changes browser thread subscriptions nor forwards raw turn/item output, tool commands, approval payloads, or request IDs. Approval recipients remain immutable and one-shot under the pilot's existing routing. An overview tab cannot claim an already-pending approval by opening its task; answer in the original recipient tab. No new approval takeover mechanism is added.

A parent ID plus explicit direct-input support is labeled **Delegated task**; explicit rejection is **Internal agent**. This is an operational capability distinction, not a claim that the protocol supplies a Desktop/user-visible visibility flag. Missing capability is **Descendant · input unknown**. Subagent sources without a parent remain visible without inventing ancestry.

The visible page polls every two seconds (eight when hidden). The server deduplicates in-flight discovery and caches for 1.5 seconds. Metadata reads have concurrency six. Pagination loops, malformed inventory, and limits (2,000 entries, 100 pages) produce an explicit stale/incomplete state rather than silently truncating. Notifications received during discovery win over older snapshots. A disconnected or failed overview retains the last known rows with a stale indicator; it never treats a failed read as an empty successful inventory.

Activity uses server `updatedAt` until meaningful lifecycle/item events are observed, then labels those events with local receipt time. Polling and token-usage messages do not advance activity. These timestamps are not proof of detailed activity from unobserved streams. `idle`, `notLoaded`, and `unknown` do not imply success.

Task-controlled text is inserted with DOM `textContent`; no HTML interpretation. Existing localhost defaults, rendering sanitizer, thread event routing, and permission/sandbox settings remain in place. No remote app-server connector or new listener is introduced.

## Verification

Hermetic CI includes `tests/agent-overview.test.ts`, the overview isolation case in `tests/thread-isolation.integration.test.ts`, and `tests/agent-command-center.e2e.mjs`. The browser test covers a nested hierarchy, ancestor-preserving search, hostile title text, task opening with unsupported history, internal input rejection, live status, responsive layout, SSE fallback, and offline recovery. Screenshots are generated under `.artifacts/`.

Run:

```sh
bun run test:ci
bun run check
bun run build
bun tests/agent-overview.live.mjs
git diff --check
```

The opt-in live smoke uses the installed binary with a disposable home and no model turns. The final integration record includes the exact counts and outcomes.
