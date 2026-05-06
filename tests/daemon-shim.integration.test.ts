import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection, type Socket } from 'net'
import { startDaemon, type DaemonHandle } from '../src/daemon'
import { FakeDiscordOps } from '../src/discord-ops'
import { writeFrame, readFrames } from '../src/framing'

let dir: string
let daemon: DaemonHandle | null = null

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'discord-daemon-')) })
afterEach(async () => {
  if (daemon) { await daemon.shutdown(); daemon = null }
  rmSync(dir, { recursive: true, force: true })
})

async function connect(sockPath: string): Promise<Socket> {
  return new Promise<Socket>((res, rej) => {
    const sock = createConnection(sockPath)
    sock.once('connect', () => res(sock))
    sock.once('error', rej)
  })
}

describe('daemon: socket', () => {
  test('binds the socket file and accepts connections', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    writeFrame(sock, { type: 'ping', id: 1 })
    let pong: any = null
    for await (const m of readFrames(sock)) {
      pong = m; break
    }
    expect(pong).toEqual({ type: 'pong', id: 1 })
    sock.end()
  })

  test('second startDaemon on same dir errors', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    let threw = false
    try {
      await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    } catch { threw = true }
    expect(threw).toBe(true)
  })
})
