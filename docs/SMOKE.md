# Smoke test matrix

Run before tagging a release. All cases require a real Discord bot token,
a guild the bot is in, and a parent channel set up per README.

## Setup

```sh
export PATH="$HOME/.bun/bin:$PATH"
cd ~/code/github.com/danielfbm/claude-discord-multisession
bun install
bun test                        # unit + integration; should be all green
```

Then in Claude Code:

```
/plugin install ./   # or wherever this checkout lives
/reload-plugins
/discord:configure MTIz...
/discord:access pair <code>     # after first DM
/discord:configure parent <parent-channel-id>
```

## Cases

1. **Single DM session (regression)**
   - `claude --channels plugin:discord@danielfbm` (no DISCORD_THREAD_ID)
   - DM the bot. Expect: pairing flow if first time, then conversation.
   - Confirm `~/.claude/channels/discord/daemon.sock` exists during the
     session and `~/.claude/channels/discord/daemon.pid` shows the PID.
   - Stop CC. Confirm daemon exits ~60 s later
     (`pgrep -af 'discord.*--daemon'` empty, sock file gone).

2. **Single thread session**
   - `DISCORD_THREAD_ID=auto claude --channels plugin:discord@danielfbm`
   - Expect: a new thread `<cwd-basename>-<id>` appears under
     parentChannelId. Bot replies inside the thread.
   - @mention the bot in the thread; confirm reply.
   - Confirm `~/.claude/channels/discord/bindings.json` has the entry.

3. **DM + thread, concurrent**
   - Terminal A: DM session (case 1 setup).
   - Terminal B: `DISCORD_THREAD_ID=auto claude --channels …` from a
     different repo.
   - Send a DM and a thread message at roughly the same time. Confirm
     only the right session sees each (each terminal's transcript shows
     only its own inbound).

4. **Two thread sessions**
   - Two terminals, two repos, both with `DISCORD_THREAD_ID=auto`.
   - Two threads appear, two sessions, no crosstalk.

5. **Daemon restart with sessions running**
   - With case 4 running, `pkill -f 'discord.*--daemon'`.
   - Send a message in either thread. The shim's next outbound tool call
     should reconnect through the lazy-spawn path.
   - Inbound after restart resumes for both sessions (the bindings.json
     re-attach logic kicks in when each shim re-registers — currently a
     manual nudge: send a new message from the shim side first).

6. **`parentChannelId` unset**
   - Clear it: `/discord:access set parentChannelId ""`.
   - Try `DISCORD_THREAD_ID=auto claude --channels …`. Expect a clear
     stderr line "discord shim: register failed (parent_channel_unset)"
     and CC reports the channel as failed to start.

7. **Permission prompt in thread**
   - In a thread session, ask Claude to run a tool that triggers a
     permission request. Buttons should appear in the thread itself, not
     in DMs.
   - Click Allow → tool proceeds; click Deny → tool is denied.
   - Click "See more" → expanded preview of the tool input shows in the
     thread.

8. **Pairing flow still works**
   - Reset `dmPolicy` to `pairing`. DM the bot from a non-allow-listed
     account. Confirm the pairing-code reply lands in DM.

9. **DM session conflict**
   - Start two DM sessions concurrently. The second should fail to
     register with `dm_session_taken`; the channel reports a failure on
     CC's side.

10. **Thread session conflict**
    - Try to bind two CC sessions to the same explicit `DISCORD_THREAD_ID`.
      Second should fail with `thread_session_taken`.

## Known limitations

- Thread auto-create defaults to **public** threads. Private threads
  require explicit invitations and are not yet supported.
- After a daemon crash, in-flight `permission_request` decisions in the
  pendingPermissions map are lost (the buttons say "Details no longer
  available" if clicked after restart). Decisions made before the crash
  via the daemon are not replayed.
- Multi-machine is not supported — all sessions must run on the same
  host as the daemon.
