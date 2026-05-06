/**
 * High-level lifecycle test: simulates a full session through the daemon
 * with the FakeDiscordOps backend. The integration tests cover finer-grained
 * cases; this exercises a common end-to-end happy path.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection, type Socket } from 'net'
import { startDaemon, type DaemonHandle } from '../src/daemon'
import { FakeDiscordOps } from '../src/discord-ops'
import { saveAccess, defaultAccess } from '../src/access'
import { writeFrame, readFrames } from '../src/framing'

let dir: string
let daemon: DaemonHandle | null = null
const liveSockets: Socket[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'discord-e2e-')) })
afterEach(async () => {
  for (const s of liveSockets) { try { s.destroy() } catch {} }
  liveSockets.length = 0
  if (daemon) { await daemon.shutdown(); daemon = null }
  rmSync(dir, { recursive: true, force: true })
})

async function connect(sockPath: string): Promise<Socket> {
  const sock = await new Promise<Socket>((res, rej) => {
    const s = createConnection(sockPath)
    s.once('connect', () => res(s))
    s.once('error', rej)
  })
  liveSockets.push(sock)
  return sock
}

function frameIterator(sock: Socket) {
  return readFrames(sock)[Symbol.asyncIterator]() as AsyncIterator<unknown>
}

async function recv(it: AsyncIterator<unknown>): Promise<any> {
  const { value, done } = await it.next()
  if (done) throw new Error('iterator ended')
  return value
}

describe('e2e: full session', () => {
  test('register → inbound → tool_call → permission cycle', async () => {
    const ops = new FakeDiscordOps()
    const a = defaultAccess()
    a.allowFrom = ['user-1']
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })

    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)

    // Register a thread session.
    writeFrame(sock, {
      type: 'register', id: 1, session_id: 'sess', mode: 'thread',
      cwd: '/work/cool-app', thread_id: 'auto',
    })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    const threadId = ack.thread_id

    // Inbound thread message arrives → routed to this shim.
    daemon.deliverInbound({
      chat_id: threadId, message_id: 'msg1', user: 'alice', user_id: 'user-1',
      ts: '2026-01-01T00:00:00Z', content: 'do the thing',
      isDM: false, parentChannelId: 'parent-1',
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })
    const inbound = await recv(it)
    expect(inbound.type).toBe('inbound')
    expect(inbound.content).toBe('do the thing')

    // Shim makes a reply tool_call → daemon dispatches to ops.
    writeFrame(sock, { type: 'tool_call', id: 2, name: 'reply', args: { chat_id: threadId, text: 'on it' } })
    const toolResult = await recv(it)
    expect(toolResult.type).toBe('tool_result')
    expect(toolResult.isError).toBeUndefined()
    expect(ops.calls.find(c => c.kind === 'reply' && c.text === 'on it')).toBeTruthy()

    // Shim issues a permission_request → daemon posts to thread.
    writeFrame(sock, {
      type: 'permission_request', id: 3, request_id: 'fxbcd',
      tool_name: 'Bash', description: 'run x', input_preview: '{"cmd":"x"}',
    })
    await new Promise(r => setTimeout(r, 30))
    expect(ops.calls.find(c => c.kind === 'permPrompt' && c.chat_id === threadId)).toBeTruthy()

    // User clicks Allow on Discord (simulated) → daemon notifies shim.
    daemon.permissionDecision('fxbcd', 'allow')
    const decision = await recv(it)
    expect(decision.type).toBe('permission_decision')
    expect(decision.behavior).toBe('allow')
  })
})
