import { createServer, createConnection, type Server, type Socket } from 'net'
import { mkdirSync, unlinkSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { readFrames, writeFrame } from './framing'
import { parseShimMsg } from './protocol'
import type { DiscordOps } from './discord-ops'

export type DaemonOpts = {
  stateDir: string
  ops: DiscordOps
  idleExitMs: number
}

export type DaemonHandle = {
  shutdown(): Promise<void>
}

async function probeStaleSocket(sockPath: string): Promise<void> {
  // Try to connect: if successful, a daemon is alive → reject.
  // If ECONNREFUSED (or any error), the socket is stale → unlink it.
  const result = await new Promise<'alive' | 'stale'>(res => {
    const probe = createConnection(sockPath)
    probe.once('connect', () => { probe.destroy(); res('alive') })
    probe.once('error', () => { probe.destroy(); res('stale') })
  })
  if (result === 'alive') throw new Error(`daemon already running at ${sockPath}`)
  try { unlinkSync(sockPath) } catch {}
}

export async function startDaemon(opts: DaemonOpts): Promise<DaemonHandle> {
  const { stateDir, ops: _ops, idleExitMs } = opts
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const sockPath = join(stateDir, 'daemon.sock')
  const pidPath = join(stateDir, 'daemon.pid')

  if (existsSync(sockPath)) await probeStaleSocket(sockPath)

  const server: Server = createServer()
  await new Promise<void>((res, rej) => {
    server.once('error', rej); server.once('listening', () => res())
    server.listen(sockPath)
  })
  try { chmodSync(sockPath, 0o600) } catch {}
  writeFileSync(pidPath, String(process.pid) + '\n', { mode: 0o600 })

  const clients = new Set<Socket>()
  let idleTimer: NodeJS.Timeout | null = null
  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    if (clients.size === 0) {
      idleTimer = setTimeout(() => { void shutdown() }, idleExitMs)
      idleTimer.unref()
    }
  }

  let stopped = false
  async function shutdown(): Promise<void> {
    if (stopped) return
    stopped = true
    if (idleTimer) clearTimeout(idleTimer)
    for (const c of clients) { try { c.destroy() } catch {} }
    await new Promise<void>(r => server.close(() => r()))
    try { unlinkSync(sockPath) } catch {}
    try { unlinkSync(pidPath) } catch {}
  }

  server.on('connection', (sock: Socket) => {
    clients.add(sock)
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    void handleConnection(sock)
      .catch(err => { try { sock.destroy(err as Error) } catch {} })
      .finally(() => { clients.delete(sock); armIdle() })
  })

  armIdle()

  return { shutdown }
}

async function handleConnection(sock: Socket): Promise<void> {
  for await (const raw of readFrames(sock)) {
    let msg
    try { msg = parseShimMsg(raw) } catch (err) {
      writeFrame(sock, { type: 'error', message: String(err) })
      continue
    }
    switch (msg.type) {
      case 'ping':
        writeFrame(sock, { type: 'pong', id: msg.id })
        break
      default:
        writeFrame(sock, { type: 'error', message: `unsupported in skeleton: ${msg.type}` })
    }
  }
}
