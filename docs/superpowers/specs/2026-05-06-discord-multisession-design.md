# Discord plugin: one bot, many Claude Code sessions

**Status:** draft
**Date:** 2026-05-06
**Owner:** danielfbm

## Goal

Let one Discord bot serve N concurrent Claude Code sessions on a single host,
with each session bound to its own Discord thread under a configured parent
channel. Direct messages to the bot continue to land in a single "DM session"
that behaves like the current plugin.

## Non-goals (v1)

- **Multi-machine deployments.** All sessions live on the same host as the bot
  daemon. Multi-machine support is a v2 concern requiring TCP/TLS transport,
  attachment streaming, and authenticated daemon discovery — explicitly
  deferred.
- **Discord-driven session creation.** A Discord message cannot spawn a new
  Claude Code session. Sessions only come from the user running `claude`
  somewhere; the bot never invokes Claude Code itself.
- **Sub-agents per thread inside one session.** This is about *separate* CC
  sessions (independent contexts, working directories), not parallel
  conversations within one session.

## Constraints

1. **Discord allows exactly one gateway connection per bot token.** A second
   login forcibly disconnects the first. Any architecture that has multiple
   processes calling `client.login(token)` is a non-starter.
2. **Claude Code's `--channels` mechanism spawns one MCP server per session.**
   We can't ask Claude Code to share an MCP server across sessions.
3. **Apache-2.0 license must be preserved**, including modification notices on
   files we change. Source attribution to upstream
   `anthropics/claude-plugins-official@48aa4351` lives in the initial commit.

## Architecture

A long-lived **daemon** holds the single Discord gateway connection. Each
Claude Code session launches a thin **shim** (the file invoked by `--channels`)
that connects to the daemon over a Unix domain socket and forwards traffic in
both directions.

```
                         ┌──────────────┐
                         │   Discord    │
                         └──────┬───────┘
                                │ gateway (single login)
                         ┌──────▼───────┐
                         │    daemon    │  long-lived,
                         │  (server.ts) │  single process
                         └──┬─┬─┬───────┘
                  UDS @  ~/.claude/channels/discord/daemon.sock
                  ┌────────┘ │ └────────┐
              ┌───▼──┐   ┌──▼───┐   ┌──▼────┐
              │ shim │   │ shim │   │ shim  │  one per CC session,
              │  A   │   │  B   │   │   C   │  spawned by --channels
              └──┬───┘   └──┬───┘   └──┬────┘
            stdio MCP   stdio MCP   stdio MCP
              ┌──▼───┐   ┌──▼───┐   ┌──▼────┐
              │ CC A │   │ CC B │   │ CC C  │
              │ DM   │   │thread│   │thread │
              │      │   │  T1  │   │  T2   │
              └──────┘   └──────┘   └───────┘
```

Roles:

- **Daemon** owns the Discord SDK, the gateway connection, the access policy,
  and the inbound→shim routing table. It exposes Discord operations (reply,
  react, fetch_messages, …) over the UDS protocol.
- **Shim** owns its single MCP/stdio connection to Claude Code. It registers
  with the daemon at boot, forwards `notifications/claude/channel` and
  permission decisions in both directions, and proxies tool calls to the
  daemon.
- **No state in the shim.** All persistent state lives on the daemon side
  (`access.json`, `bindings.json`, `inbox/`, `approved/`).

### Daemon lifecycle

- **Lazy spawn.** On boot, the shim looks for a live socket at
  `~/.claude/channels/discord/daemon.sock`. If `connect()` succeeds and a
  health-check `ping` returns within 2 s, the shim uses that daemon. Otherwise
  it spawns a new daemon as a detached child (`bun server.ts --daemon`),
  redirecting the daemon's stdio to `daemon.log` so the shim's MCP stdio
  isn't polluted, then waits up to 5 s for the socket to appear and retries.
- **Idle exit.** When the last shim disconnects, the daemon waits 60 s for any
  shim to reattach (covers `/reload-plugins`, transient restarts), then
  destroys the Discord client and exits.
- **Single instance.** The daemon takes an exclusive `flock` on
  `~/.claude/channels/discord/daemon.lock` before binding the socket. A
  second daemon attempt detects the lock and exits cleanly.

### Shim lifecycle

- Bun process invoked by Claude Code via `--channels plugin:discord@…`.
- Reads `DISCORD_THREAD_ID` from env:
  - **Unset** → registers as the *DM session* (one allowed at a time).
  - **`auto`** → asks daemon to create a new thread under
    `parentChannelId` and bind to it.
  - **`<snowflake>`** → asks daemon to bind to an existing thread; daemon
    verifies the thread is under an opted-in parent channel.
- On EOF from Claude Code (session quit, `/reload-plugins`), the shim sends
  `unregister` and exits. The thread persists on Discord; the binding
  persists in `bindings.json` so a reconnecting shim with the same
  `session_id` re-attaches to its thread.

### Session identity

For v1, the shim's `session_id` is `sha1(realpath(cwd))[:12]`. Implications:

- Two simultaneous Claude Code sessions in the *same* working directory will
  collide; the second `register` is rejected. Acceptable rule: one CC per
  cwd.
- Restarting CC in the same cwd reattaches to the same thread automatically.
- If Claude Code later exposes a real session UUID via env (e.g.
  `CLAUDE_SESSION_ID`), the shim should prefer that and fall back to the
  cwd hash. This is a small follow-up, not a blocker.

### Auto-naming

When a shim asks the daemon to auto-create a thread, the thread name is
`<basename(cwd)>-<session_id[:6]>`. Example: `my-project-a1b2c3`. Discord
permits up to 100 chars; basename is truncated to 80 with the suffix
appended.

A future iteration may use the first user message to title the thread (one
short LLM call inside the daemon); deferred from v1 because it requires
extra config (model API key) and adds latency before the first reply.

## Wire protocol

Newline-delimited JSON over UDS at
`~/.claude/channels/discord/daemon.sock`. Socket file is `0600`; parent dir
is `0700`. fs perms are the only auth — anyone able to `read` the socket
already has full access to the user's `~/.claude`.

Messages have a `type` field. Requests carry an `id`; replies echo it.

### Shim → daemon

- `register` `{type, id, session_id, mode: "dm"|"thread", cwd, thread_id?}`
  Reply: `register_ack {id, session_id, thread_id, thread_name?, thread_url?}`
  or `register_err {id, code, message}` (codes: `dm_session_taken`,
  `thread_session_taken`, `parent_channel_unset`, `thread_not_allowed`,
  `discord_unavailable`).
- `tool_call` `{type, id, name, args}` — name ∈ `reply | react |
  edit_message | fetch_messages | download_attachment`. Reply:
  `tool_result {id, content, isError?}`. Args mirror the existing tool
  schemas verbatim; no behavior change inside the daemon.
- `permission_request` `{type, id, request_id, tool_name, description,
  input_preview}` — shim forwards CC's permission ask. Daemon posts
  buttons (in the bound thread for thread-mode shims, fanned to allowFrom
  DMs for the DM-mode shim) and stores `request_id → session_id` so it can
  route the eventual decision back.
- `unregister` `{type, id}` — graceful shutdown. Daemon removes the
  in-memory route but leaves `bindings.json` intact.
- `ping` `{type, id}` — health check for shim-side reconnect logic.

### Daemon → shim

- `inbound` `{type, chat_id, message_id, user, user_id, ts, content,
  attachments?}` — a Discord message routed to this shim. The shim wraps
  it as `notifications/claude/channel` for Claude Code.
- `permission_decision` `{type, request_id, behavior: "allow"|"deny"}` —
  result of the user's button click. Shim forwards as
  `notifications/claude/channel/permission`.
- `register_ack`, `register_err`, `tool_result`, `pong` — replies to the
  above.

### Backpressure & errors

- The socket is line-delimited JSON; messages over 1 MiB are rejected (no
  Discord operation needs that). Attachments transit by *path*, not bytes,
  on the local-only assumption.
- If the daemon's send to a shim fails (broken pipe), the daemon clears the
  in-memory route. The next `register` from that session reattaches.

## State files

All under `~/.claude/channels/discord/` (or `$DISCORD_STATE_DIR`):

| Path | Owner | Purpose |
| --- | --- | --- |
| `.env` | user | `DISCORD_BOT_TOKEN=…`. Unchanged. |
| `access.json` | `/discord:access` skill | Existing fields kept. **New**: `parentChannelId` (snowflake of the channel under which auto-thread-creation happens). |
| `bindings.json` | daemon | `{ "<session_id>": { "thread_id": "<snowflake>", "cwd": "…", "created_at": <ms>, "last_seen_at": <ms> } }`. Daemon writes atomically (tmp + rename). |
| `daemon.sock` | daemon | UDS endpoint. |
| `daemon.lock` | daemon | flock target for single-instance enforcement. |
| `daemon.pid` | daemon | PID for diagnostics. |
| `daemon.log` | daemon | Append-only log of daemon stderr (no rotation in v1; user truncates). |
| `approved/<senderId>` | `/discord:access` skill | Unchanged. |
| `inbox/` | daemon | Unchanged. |

`bindings.json` schema is forward-compatible: extra keys are tolerated.

## Routing rules

### Inbound DMs

- Existing gate logic runs unchanged inside the daemon
  (`pairing` / `allowlist` / `disabled`, `allowFrom`).
- Allowed DM → daemon delivers `inbound` to the registered DM-mode shim.
  - If no DM-mode shim is registered, the message is dropped with an `❓`
    ack reaction so the user knows it landed nowhere.
- Pairing replies, `approved/<senderId>` polling, and the
  `PERMISSION_REPLY_RE` text-pattern intercept all stay on the daemon.

### Inbound thread messages

- `gate()` already resolves `parentId` for thread messages and looks up the
  parent channel's policy. That logic stays.
- After the gate passes, the daemon checks `bindings` for any session
  bound to that thread:
  - **Bound** → deliver `inbound` to that shim.
  - **Unbound** → drop with `❓` ack reaction. The user can attach a
    session by running `claude` with `DISCORD_THREAD_ID=<snowflake>` (or
    via a future `/discord:bind` skill — out of scope for v1).

### Inbound guild-channel messages (not in a thread)

- Messages in any opted-in `groups` channel that are *not* in a thread
  pass the existing gate (mention check, per-channel allowFrom) and are
  delivered to the **DM-mode shim**. Thread-mode shims can never claim
  them — they only own their bound thread.
- Rationale: today's user can @mention the bot in a guild channel and get
  a reply via the single CC session. We preserve that by routing those
  messages to the same place DMs go.
- If no DM-mode shim is registered, these messages drop with `❓`. The
  user is expected to keep one CC running for the DM/control channel.

### `parentChannelId` and `groups`

`parentChannelId` is the channel under which auto-create spawns threads.
Inbound thread messages still go through the existing gate, which requires
the thread's parent to be in `groups`. The `/discord:configure` skill, when
setting `parentChannelId`, also opts that channel into `groups` (with
`requireMention: true` and an empty `allowFrom`) if it isn't already, so
auto-created threads route correctly out of the box.

### Permission requests

- Originating shim's mode determines the destination:
  - **DM-mode shim** → buttons fanned to all `allowFrom` user DMs (today's
    behavior).
  - **Thread-mode shim** → buttons posted **inside the bound thread**.
    Co-locating the request with the work it's for is the whole point of
    the multi-session model.
- Decisions route back via `request_id → session_id` lookup in the daemon.

## Backwards compatibility

- A user with one bot and one session sees the same UX as today: their CC
  process launches a shim, the shim spawns a daemon, the daemon connects to
  Discord, DMs flow. The visible difference is one extra `bun` process and a
  60 s daemon idle-exit grace period.
- `access.json` is a strict superset; existing files load unchanged.
- `parentChannelId` is only required when a shim asks for a `thread` mode
  binding. DM-only users never need to set it.
- `DISCORD_ACCESS_MODE=static` still works: daemon snapshots access at boot
  and refuses pairing, identical to today.
- Tool surface to Claude Code is unchanged: same five tools, same args, same
  result shapes.

## Security

- **Prompt injection guardrails preserved.** The daemon never reads
  `access.json` mutations from inbound messages, never invokes
  `/discord:access`, and refuses sender-supplied "approve me" requests. Same
  reasoning as today, just inside the daemon.
- **UDS permissions.** Socket `0600`, parent dir `0700`. The fs is the auth
  boundary on a single-user host.
- **Shim can't escalate.** A compromised shim can ask the daemon to run any
  of the existing tools, but those tools are already gated by `access.json`;
  the daemon refuses to send to non-allowlisted channels. The shim cannot
  mutate `access.json` (skill-only).
- **Token blast radius unchanged.** The token still lives in `.env`, still
  loaded by the daemon, never on the wire.
- **Permission relay still requires authenticated replier.** Buttons in
  threads only count if the clicker's user ID is in `allowFrom`. The
  declaration of `claude/channel/permission` capability stands.

## Failure modes

| Scenario | Behavior |
| --- | --- |
| Daemon dies mid-session | Shim's next outbound call fails; shim attempts one reconnect-and-spawn. If that fails, the tool call returns an error to Claude Code. Inbound messages from Discord during the gap are seen by Discord but not by any shim — Discord retains them in channel history. |
| Discord gateway drops | discord.js auto-reconnects (existing behavior). Daemon stays up; shims are unaffected. |
| Two shims register the same `session_id` | Second `register` returns `dm_session_taken` (DM mode) or `thread_session_taken` (thread mode). The shim fails fast with a clear stderr message; CC reports the channel as failed. |
| Thread is archived on Discord | Sending to an archived thread auto-unarchives (Discord behavior). No special handling. |
| `parentChannelId` unset, shim asks for `auto` | `register_err {code: parent_channel_unset}`; shim writes a clear stderr line pointing the user at `/discord:access set parentChannelId <id>` and exits. |
| `bindings.json` corrupt | Daemon renames it aside (`.corrupt-<ts>`) and starts fresh. Sessions reconnect; threads on Discord persist but no longer auto-route until a shim re-binds. |

## Testing strategy

This is a single-user plugin with networked external dependencies; we won't
attempt full automated coverage. Plan:

1. **Unit-ish tests for pure logic** in the daemon: chunking, gate, name
   derivation, `bindings.json` round-trip. Existing `server.ts` has no tests
   today; we don't backfill all of it, just the new code.
2. **Manual smoke test matrix** (documented in the README):
   - Single session, DM mode (regression).
   - Single session, thread mode (`DISCORD_THREAD_ID=auto`).
   - Two sessions, one DM + one thread.
   - Two sessions, both threads.
   - Daemon restart with a session running (reconnect).
   - `parentChannelId` unset (clear error).
3. **fakechat plugin as a stand-in** for any future automated channel work
   — out of scope for v1.

## File layout (post-implementation)

```
.
├── .claude-plugin/plugin.json
├── .mcp.json                    # invokes shim
├── README.md                    # user-facing setup; updated to mention threads
├── ACCESS.md                    # access doc; gains parentChannelId section
├── LICENSE                      # Apache-2.0, preserved
├── package.json                 # adds "daemon" script
├── server.ts                    # entry — dispatches to daemon or shim by argv/env
├── src/
│   ├── daemon.ts                # gateway, routing, UDS server
│   ├── shim.ts                  # MCP server, UDS client
│   ├── protocol.ts              # zod schemas for the wire protocol
│   ├── access.ts                # access.json reader/writer (extracted from server.ts)
│   ├── chunk.ts                 # message chunker (extracted)
│   └── bindings.ts              # bindings.json reader/writer
├── docs/superpowers/specs/
│   └── 2026-05-06-discord-multisession-design.md   # this doc
└── skills/
    ├── access/                  # gains parentChannelId support
    └── configure/               # gains parentChannelId guidance
```

`server.ts` becomes a small entrypoint. The bulk of today's logic moves to
`src/daemon.ts` mostly verbatim, plus the new UDS server. `src/shim.ts` is
the new ~200-line file that translates between MCP-stdio and UDS.

## Open implementation questions

These don't block the spec but will be resolved during the plan/code phase:

1. **Detached spawn from the shim.** `Bun.spawn(..., {detached: true})` plus
   `unref()` should suffice; we'll verify the daemon survives shim exit on
   Linux/macOS.
2. **`session_id` source.** Confirm whether `--channels` MCP servers receive
   any CC-supplied session/UUID env var in current Claude Code releases. If
   yes, prefer it; otherwise stick with the cwd hash.
3. **Auto-thread permissions.** Discord requires `Create Public Threads`
   permission on the parent channel. The README's invite-URL section needs
   the new permission added.
4. **Thread visibility.** Public vs private thread for auto-create — public
   is the lowest-friction default; private requires the bot or user to add
   each member. Default to public; document the trade-off.
5. **`/discord:bind <thread>` skill.** Useful but not strictly needed for
   v1 since `DISCORD_THREAD_ID=<snowflake>` works. Land in v1.1 if user
   demand emerges.

## Decisions log (during brainstorming)

- Architecture: daemon + shim over UDS (chose A over leader-election B and
  one-session router C).
- Thread auto-create with cwd-derived names (chose YAGNI over LLM-generated
  titles).
- DM-mode shim is "the unbound one" (chose implicit rule over explicit env
  marker; reversible if it confuses users).
- Daemon lazy-spawned by first shim (chose this over explicit
  `/discord:daemon start`).
- Single-host only in v1; multi-machine deferred to v2.
