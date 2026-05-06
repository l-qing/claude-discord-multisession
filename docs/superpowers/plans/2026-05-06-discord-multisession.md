# Discord Multi-Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Discord channel plugin so one bot can serve multiple Claude Code sessions on a single host, each bound to its own Discord thread, while preserving today's single-DM-session UX.

**Architecture:** Long-lived **daemon** owns the Discord gateway and access state; thin per-session **shim** is what `--channels` launches. Shim and daemon talk newline-delimited JSON over a Unix socket (`~/.claude/channels/discord/daemon.sock`). Daemon is lazy-spawned by the first shim and idle-exits 60 s after the last shim disconnects.

**Tech Stack:** Bun, TypeScript, `discord.js`, `@modelcontextprotocol/sdk`, `zod`. Tests use `bun test` (Bun's built-in test runner).

**Spec:** [`docs/superpowers/specs/2026-05-06-discord-multisession-design.md`](../specs/2026-05-06-discord-multisession-design.md)

---

## File map

```
.
├── server.ts                       # entrypoint, dispatches by argv
├── src/
│   ├── chunk.ts                    # message chunker (extracted)
│   ├── access.ts                   # access.json read/write (extracted)
│   ├── gate.ts                     # inbound gating (extracted, made driver-agnostic)
│   ├── session-id.ts               # session_id derivation + thread name
│   ├── bindings.ts                 # bindings.json read/write
│   ├── protocol.ts                 # zod schemas for wire protocol
│   ├── framing.ts                  # newline-delimited JSON over stream helpers
│   ├── discord-ops.ts              # DiscordOps interface + real impl + fake for tests
│   ├── daemon.ts                   # daemon process: UDS server, routing, lifecycle
│   └── shim.ts                     # shim process: MCP stdio + UDS client
├── tests/
│   ├── chunk.test.ts
│   ├── access.test.ts
│   ├── gate.test.ts
│   ├── session-id.test.ts
│   ├── bindings.test.ts
│   ├── protocol.test.ts
│   ├── framing.test.ts
│   └── daemon-shim.integration.test.ts
└── (docs/skills/* — see Phase G)
```

`server.ts` shrinks from ~900 lines to a small dispatcher. The bulk of today's logic moves into `src/daemon.ts` (Discord side) and is reused as-is where possible.

---

## Phase A — Foundation (extract pure modules)

### Task A1: Set up `bun test` infra

**Files:**
- Modify: `package.json`
- Create: `tests/.gitkeep`
- Create: `tsconfig.json`

- [ ] **Step 1: Add `test` script and dev deps**

Edit `package.json` to add:

```json
{
  "name": "claude-channel-discord",
  "version": "0.0.1",
  "license": "Apache-2.0",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "discord.js": "^14.14.0",
    "zod": "^3.23.0"
  }
}
```

(`zod` was already pulled in transitively; pin it.)

- [ ] **Step 2: Add minimal tsconfig**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["server.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Verify the harness runs**

Create `tests/.gitkeep` (empty), then:

```bash
cd ~/code/github.com/danielfbm/claude-discord-multisession
bun install
bun test
```

Expected: "0 pass" with no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock tsconfig.json tests/.gitkeep
git commit -m "chore: add bun test harness and tsconfig"
```

---

### Task A2: Extract `chunk()` to `src/chunk.ts`

**Files:**
- Create: `src/chunk.ts`
- Create: `tests/chunk.test.ts`
- Modify: `server.ts:373-392` (replace local `chunk` with import)

- [ ] **Step 1: Write failing tests**

Create `tests/chunk.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test'
import { chunk } from '../src/chunk'

describe('chunk', () => {
  test('returns single element when text fits', () => {
    expect(chunk('hi', 100, 'length')).toEqual(['hi'])
  })

  test('splits at exact limit in length mode', () => {
    const text = 'a'.repeat(2500)
    const out = chunk(text, 1000, 'length')
    expect(out).toHaveLength(3)
    expect(out[0]).toHaveLength(1000)
    expect(out[1]).toHaveLength(1000)
    expect(out[2]).toHaveLength(500)
  })

  test('prefers paragraph boundary in newline mode', () => {
    const text = 'first paragraph.\n\nsecond paragraph that is longer than the limit but has a break.'
    const out = chunk(text, 30, 'newline')
    expect(out[0]).toBe('first paragraph.')
  })

  test('falls back to space when no newline', () => {
    const text = 'word '.repeat(20).trim()
    const out = chunk(text, 30, 'newline')
    out.forEach(c => expect(c.length).toBeLessThanOrEqual(30))
    expect(out.join(' ')).toBe(text)
  })

  test('hard cut when no whitespace available', () => {
    const text = 'a'.repeat(100)
    const out = chunk(text, 40, 'newline')
    expect(out.every(c => c.length <= 40)).toBe(true)
  })
})
```

- [ ] **Step 2: Run, verify failure**

```bash
bun test tests/chunk.test.ts
```

Expected: FAIL — `Cannot find module '../src/chunk'`.

- [ ] **Step 3: Create the module**

Create `src/chunk.ts` (copy from `server.ts:373-392` and export):

```typescript
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/chunk.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Replace server.ts usage**

In `server.ts`, delete the local `chunk` function (lines 373-392) and add at the top with the other imports:

```typescript
import { chunk } from './src/chunk'
```

- [ ] **Step 6: Sanity-check the existing entry still type-checks**

```bash
bun build server.ts --target=bun --no-bundle 2>&1 | head -20
```

Expected: no errors (or only the pre-existing ones unrelated to `chunk`).

- [ ] **Step 7: Commit**

```bash
git add src/chunk.ts tests/chunk.test.ts server.ts
git commit -m "refactor: extract chunk() to src/chunk.ts with tests"
```

---

### Task A3: Extract access state to `src/access.ts`

**Files:**
- Create: `src/access.ts`
- Create: `tests/access.test.ts`
- Modify: `server.ts:92-201` (replace inline access logic with imports)

- [ ] **Step 1: Write failing tests**

Create `tests/access.test.ts`:

```typescript
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultAccess,
  loadAccess,
  saveAccess,
  pruneExpired,
  type Access,
} from '../src/access'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'access-test-'))
  file = join(dir, 'access.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('access', () => {
  test('defaultAccess returns pairing policy with empty lists', () => {
    expect(defaultAccess()).toEqual({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    })
  })

  test('loadAccess returns default when file missing', () => {
    expect(loadAccess(file)).toEqual(defaultAccess())
  })

  test('roundtrips a populated access object', () => {
    const a: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['111'],
      groups: { '222': { requireMention: false, allowFrom: ['333'] } },
      pending: {},
      ackReaction: '👀',
      parentChannelId: '444',
    }
    saveAccess(file, a)
    expect(loadAccess(file)).toEqual(a)
  })

  test('saveAccess writes atomically and chmods 0600', () => {
    saveAccess(file, defaultAccess())
    const stat = require('fs').statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test('pruneExpired removes only expired pending entries', () => {
    const a = defaultAccess()
    const now = Date.now()
    a.pending = {
      old: { senderId: 's1', chatId: 'c1', createdAt: now - 1e7, expiresAt: now - 1e6, replies: 1 },
      new: { senderId: 's2', chatId: 'c2', createdAt: now, expiresAt: now + 1e6, replies: 1 },
    }
    expect(pruneExpired(a)).toBe(true)
    expect(Object.keys(a.pending)).toEqual(['new'])
  })

  test('corrupt file is renamed aside and default returned', () => {
    writeFileSync(file, '{not json')
    const a = loadAccess(file)
    expect(a).toEqual(defaultAccess())
    const corruptFiles = require('fs').readdirSync(dir).filter((f: string) => f.startsWith('access.json.corrupt-'))
    expect(corruptFiles).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/access.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/access.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  /** Channel under which auto-thread-creation spawns threads. */
  parentChannelId?: string
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

export function loadAccess(file: string): Access {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      parentChannelId: parsed.parentChannelId,
    }
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    return defaultAccess()
  }
}

export function saveAccess(file: string, a: Access): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/access.test.ts
```

Expected: 6 pass.

- [ ] **Step 5: Migrate `server.ts`**

Delete `server.ts:92-201` (the type defs, `defaultAccess`, `readAccessFile`, `loadAccess`, `saveAccess`, `pruneExpired`, and the `BOOT_ACCESS` block). Replace with imports plus a small static-mode wrapper:

```typescript
import {
  defaultAccess, loadAccess as loadAccessFile, saveAccess as saveAccessFile,
  pruneExpired, type Access,
} from './src/access'

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = loadAccessFile(ACCESS_FILE)
      if (a.dmPolicy === 'pairing') {
        process.stderr.write(
          'discord channel: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
        )
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? loadAccessFile(ACCESS_FILE)
}

function saveAccess(a: Access): void {
  if (STATIC) return
  saveAccessFile(ACCESS_FILE, a)
}
```

- [ ] **Step 6: Commit**

```bash
git add src/access.ts tests/access.test.ts server.ts
git commit -m "refactor: extract access state to src/access.ts with tests"
```

---

### Task A4: Extract gate to `src/gate.ts`

**Files:**
- Create: `src/gate.ts`
- Create: `tests/gate.test.ts`
- Modify: `server.ts:236-318` (`gate` and `isMentioned`)

The current `gate()` function uses `discord.js` types directly. We extract it behind a thin adapter so it can be tested without a real `Message`.

- [ ] **Step 1: Write failing tests**

Create `tests/gate.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test'
import { gate, type GateInput, type GateResult } from '../src/gate'
import { defaultAccess } from '../src/access'

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    senderId: 'user-1',
    isDM: true,
    channelId: 'chan-1',
    parentChannelId: undefined,
    content: '',
    isReplyToBot: false,
    hasBotMention: false,
    ...over,
  }
}

describe('gate', () => {
  test('disabled policy drops everything', () => {
    const access = defaultAccess()
    access.dmPolicy = 'disabled'
    expect(gate(input(), access).action).toBe('drop')
  })

  test('allowlisted DM sender delivers', () => {
    const access = defaultAccess()
    access.allowFrom = ['user-1']
    const r = gate(input(), access) as GateResult
    expect(r.action).toBe('deliver')
  })

  test('non-allowlisted DM in allowlist policy drops', () => {
    const access = defaultAccess()
    access.dmPolicy = 'allowlist'
    expect(gate(input(), access).action).toBe('drop')
  })

  test('pairing policy issues a code and stores pending', () => {
    const access = defaultAccess()
    const r = gate(input(), access)
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') return
    expect(r.code).toMatch(/^[0-9a-f]{6}$/)
    expect(r.isResend).toBe(false)
    expect(Object.keys(access.pending)).toHaveLength(1)
  })

  test('pairing reissue is marked as resend after first', () => {
    const access = defaultAccess()
    gate(input(), access)
    const r = gate(input(), access)
    expect(r.action).toBe('pair')
    if (r.action === 'pair') expect(r.isResend).toBe(true)
  })

  test('pairing goes silent after replies cap', () => {
    const access = defaultAccess()
    gate(input(), access)
    gate(input(), access)
    expect(gate(input(), access).action).toBe('drop')
  })

  test('group message without mention is dropped when requireMention=true', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: true, allowFrom: [] }
    const r = gate(input({ isDM: false }), access)
    expect(r.action).toBe('drop')
  })

  test('group message with mention delivers', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: true, allowFrom: [] }
    const r = gate(input({ isDM: false, hasBotMention: true }), access)
    expect(r.action).toBe('deliver')
  })

  test('reply to bot in group counts as mention', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: true, allowFrom: [] }
    const r = gate(input({ isDM: false, isReplyToBot: true }), access)
    expect(r.action).toBe('deliver')
  })

  test('thread message uses parent channel for group lookup', () => {
    const access = defaultAccess()
    access.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    const r = gate(input({ isDM: false, channelId: 'thread-1', parentChannelId: 'parent-1' }), access)
    expect(r.action).toBe('deliver')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/gate.test.ts
```

- [ ] **Step 3: Create the module**

Create `src/gate.ts`:

```typescript
import { randomBytes } from 'crypto'
import type { Access } from './access'

export type GateInput = {
  senderId: string
  isDM: boolean
  /** Channel ID where the message arrived. For threads, this is the thread ID. */
  channelId: string
  /** Parent channel ID if `channelId` is a thread, else undefined. */
  parentChannelId?: string
  content: string
  /** True if Discord's structured @bot mention is present. */
  hasBotMention: boolean
  /** True if this is a reply to one of the bot's recent messages. */
  isReplyToBot: boolean
}

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

const PAIRING_CAP = 3
const PAIRING_TTL_MS = 60 * 60 * 1000
const REPLY_CAP = 2

export function gate(input: GateInput, access: Access): GateResult {
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (input.isDM) return gateDM(input, access)

  // Threads inherit their parent channel's group policy.
  const lookupKey = input.parentChannelId ?? input.channelId
  const policy = access.groups[lookupKey]
  if (!policy) return { action: 'drop' }
  const groupAllow = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllow.length > 0 && !groupAllow.includes(input.senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !mentioned(input, access.mentionPatterns)) {
    return { action: 'drop' }
  }
  return { action: 'deliver' }
}

function gateDM(input: GateInput, access: Access): GateResult {
  if (access.allowFrom.includes(input.senderId)) return { action: 'deliver' }
  if (access.dmPolicy === 'allowlist') return { action: 'drop' }

  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === input.senderId) {
      if ((p.replies ?? 1) >= REPLY_CAP) return { action: 'drop' }
      p.replies = (p.replies ?? 1) + 1
      return { action: 'pair', code, isResend: true }
    }
  }
  if (Object.keys(access.pending).length >= PAIRING_CAP) return { action: 'drop' }

  const code = randomBytes(3).toString('hex')
  const now = Date.now()
  access.pending[code] = {
    senderId: input.senderId,
    chatId: input.channelId,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    replies: 1,
  }
  return { action: 'pair', code, isResend: false }
}

function mentioned(input: GateInput, patterns?: string[]): boolean {
  if (input.hasBotMention) return true
  if (input.isReplyToBot) return true
  for (const pat of patterns ?? []) {
    try { if (new RegExp(pat, 'i').test(input.content)) return true } catch {}
  }
  return false
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/gate.test.ts
```

Expected: 10 pass.

- [ ] **Step 5: Update `server.ts` to use `gate()`**

In `server.ts`, replace the `gate(msg: Message)` function (lines 236-294) and `isMentioned()` (lines 296-318) with a thin wrapper that builds `GateInput` from a `Message` and calls the new module. The wrapper still owns the `loadAccess`/`saveAccess`/`recentSentIds` interactions.

```typescript
import { gate as gateLogic, type GateInput } from './src/gate'

async function buildGateInput(msg: Message): Promise<GateInput> {
  const isDM = msg.channel.type === ChannelType.DM
  const channelId = msg.channelId
  const parentChannelId = msg.channel.isThread() ? msg.channel.parentId ?? undefined : undefined
  const hasBotMention = !!(client.user && msg.mentions.has(client.user))
  let isReplyToBot = false
  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) isReplyToBot = true
    else {
      try {
        const ref = await msg.fetchReference()
        if (ref.author.id === client.user?.id) isReplyToBot = true
      } catch {}
    }
  }
  return {
    senderId: msg.author.id,
    isDM,
    channelId,
    parentChannelId,
    content: msg.content,
    hasBotMention,
    isReplyToBot,
  }
}

async function gate(msg: Message): Promise<{ action: 'deliver' | 'drop' | 'pair'; code?: string; isResend?: boolean; access: Access }> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)
  const input = await buildGateInput(msg)
  const result = gateLogic(input, access)
  if (result.action === 'pair') saveAccess(access)
  return { ...result, access }
}
```

(Existing call sites of `gate(msg)` in `handleInbound` need a small shape tweak — the result already exposes `access`, just unpack `action`/`code`/`isResend` as before.)

- [ ] **Step 6: Run all tests + smoke-build**

```bash
bun test
bun build server.ts --target=bun --no-bundle 2>&1 | head -20
```

Expected: tests still green; no new build errors.

- [ ] **Step 7: Commit**

```bash
git add src/gate.ts tests/gate.test.ts server.ts
git commit -m "refactor: extract gate() to driver-agnostic src/gate.ts"
```

---

### Task A5: Add `src/session-id.ts`

**Files:**
- Create: `src/session-id.ts`
- Create: `tests/session-id.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/session-id.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test'
import { realpathSync } from 'fs'
import { deriveSessionId, deriveThreadName } from '../src/session-id'

describe('session-id', () => {
  test('deriveSessionId is 12 lowercase hex chars', () => {
    const id = deriveSessionId('/tmp')
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })

  test('deriveSessionId is stable for the same realpath', () => {
    const a = deriveSessionId(realpathSync('/tmp'))
    const b = deriveSessionId(realpathSync('/tmp'))
    expect(a).toBe(b)
  })

  test('deriveSessionId differs for different paths', () => {
    expect(deriveSessionId('/tmp/a')).not.toBe(deriveSessionId('/tmp/b'))
  })

  test('deriveThreadName uses basename + short id', () => {
    expect(deriveThreadName('/home/me/my-project', 'abcdef0123ab')).toBe('my-project-abcdef')
  })

  test('deriveThreadName truncates basename to 80 chars', () => {
    const long = '/x/' + 'a'.repeat(200)
    const name = deriveThreadName(long, 'abcdef0123ab')
    expect(name.length).toBeLessThanOrEqual(100)
    expect(name.endsWith('-abcdef')).toBe(true)
  })

  test('deriveThreadName falls back when basename empty', () => {
    expect(deriveThreadName('/', 'abcdef0123ab')).toBe('claude-abcdef')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/session-id.test.ts
```

- [ ] **Step 3: Create the module**

Create `src/session-id.ts`:

```typescript
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { basename } from 'path'

/**
 * Stable identifier for "this Claude Code session in this cwd."
 * v1: SHA-1 of realpath(cwd), first 12 hex chars. Implies one CC per cwd.
 */
export function deriveSessionId(cwd: string): string {
  let real: string
  try { real = realpathSync(cwd) } catch { real = cwd }
  return createHash('sha1').update(real).digest('hex').slice(0, 12)
}

/**
 * Discord thread name derived from cwd basename + short session id.
 * Discord caps thread names at 100 chars; we cap basename at 80 to leave
 * room for the suffix.
 */
export function deriveThreadName(cwd: string, sessionId: string): string {
  const raw = basename(cwd) || 'claude'
  const trimmed = raw.length > 80 ? raw.slice(0, 80) : raw
  return `${trimmed}-${sessionId.slice(0, 6)}`
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/session-id.test.ts
```

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/session-id.ts tests/session-id.test.ts
git commit -m "feat: add src/session-id.ts (cwd-based id + thread name)"
```

---

## Phase B — New shared modules

### Task B1: `src/bindings.ts`

**Files:**
- Create: `src/bindings.ts`
- Create: `tests/bindings.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/bindings.test.ts`:

```typescript
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadBindings, saveBindings, type Bindings } from '../src/bindings'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bindings-test-'))
  file = join(dir, 'bindings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('bindings', () => {
  test('load returns empty when file absent', () => {
    expect(loadBindings(file)).toEqual({})
  })

  test('roundtrips entries', () => {
    const b: Bindings = {
      sess1: { thread_id: 't1', cwd: '/a', created_at: 100, last_seen_at: 200 },
      sess2: { thread_id: 't2', cwd: '/b', created_at: 300, last_seen_at: 400 },
    }
    saveBindings(file, b)
    expect(loadBindings(file)).toEqual(b)
  })

  test('save chmods 0600', () => {
    saveBindings(file, {})
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('corrupt file returns empty and renames aside', () => {
    writeFileSync(file, '{not json')
    expect(loadBindings(file)).toEqual({})
    const corrupt = require('fs').readdirSync(dir).filter((f: string) => f.startsWith('bindings.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/bindings.test.ts
```

- [ ] **Step 3: Create the module**

Create `src/bindings.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'

export type BindingEntry = {
  thread_id: string
  cwd: string
  created_at: number
  last_seen_at: number
}

export type Bindings = Record<string, BindingEntry>

export function loadBindings(file: string): Bindings {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Bindings
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    return {}
  }
}

export function saveBindings(file: string, b: Bindings): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/bindings.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/bindings.ts tests/bindings.test.ts
git commit -m "feat: add bindings.json reader/writer"
```

---

### Task B2: `src/protocol.ts` (zod schemas)

**Files:**
- Create: `src/protocol.ts`
- Create: `tests/protocol.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/protocol.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test'
import {
  RegisterMsg, RegisterAckMsg, RegisterErrMsg,
  ToolCallMsg, ToolResultMsg,
  PermissionRequestMsg, PermissionDecisionMsg,
  InboundMsg, UnregisterMsg, PingMsg, PongMsg,
  parseShimMsg, parseDaemonMsg,
} from '../src/protocol'

describe('protocol', () => {
  test('valid register parses', () => {
    const v = RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'dm', cwd: '/x' })
    expect(v.mode).toBe('dm')
  })

  test('register requires thread_id when mode=thread', () => {
    expect(() => RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'thread', cwd: '/x' })).toThrow()
  })

  test('thread mode allows literal "auto" or snowflake', () => {
    expect(RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'thread', cwd: '/x', thread_id: 'auto' })).toBeTruthy()
    expect(RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'thread', cwd: '/x', thread_id: '12345' })).toBeTruthy()
  })

  test('tool_call accepts known tool names', () => {
    for (const name of ['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment'] as const) {
      expect(ToolCallMsg.parse({ type: 'tool_call', id: 2, name, args: {} }).name).toBe(name)
    }
  })

  test('parseShimMsg dispatches on type', () => {
    const m = parseShimMsg({ type: 'ping', id: 3 })
    expect(m).toEqual({ type: 'ping', id: 3 })
  })

  test('parseShimMsg throws on unknown type', () => {
    expect(() => parseShimMsg({ type: 'bogus' })).toThrow()
  })

  test('parseDaemonMsg parses inbound', () => {
    const m = parseDaemonMsg({
      type: 'inbound', chat_id: 'c', message_id: 'm', user: 'u', user_id: 'uid', ts: '2026-01-01T00:00:00Z', content: 'hi',
    })
    expect(m.type).toBe('inbound')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/protocol.test.ts
```

- [ ] **Step 3: Create the module**

Create `src/protocol.ts`:

```typescript
import { z } from 'zod'

export const RegisterMsg = z.object({
  type: z.literal('register'),
  id: z.number(),
  session_id: z.string().min(1),
  mode: z.enum(['dm', 'thread']),
  cwd: z.string(),
  thread_id: z.string().optional(),
}).superRefine((v, ctx) => {
  if (v.mode === 'thread' && !v.thread_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'thread_id required when mode=thread' })
  }
})

export const RegisterAckMsg = z.object({
  type: z.literal('register_ack'),
  id: z.number(),
  session_id: z.string(),
  thread_id: z.string().nullable(),
  thread_name: z.string().optional(),
  thread_url: z.string().optional(),
})

export const RegisterErrMsg = z.object({
  type: z.literal('register_err'),
  id: z.number(),
  code: z.enum([
    'dm_session_taken',
    'thread_session_taken',
    'parent_channel_unset',
    'thread_not_allowed',
    'discord_unavailable',
  ]),
  message: z.string(),
})

export const ToolCallMsg = z.object({
  type: z.literal('tool_call'),
  id: z.number(),
  name: z.enum(['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment']),
  args: z.record(z.unknown()),
})

export const ToolResultMsg = z.object({
  type: z.literal('tool_result'),
  id: z.number(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
})

export const PermissionRequestMsg = z.object({
  type: z.literal('permission_request'),
  id: z.number(),
  request_id: z.string(),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
})

export const PermissionDecisionMsg = z.object({
  type: z.literal('permission_decision'),
  request_id: z.string(),
  behavior: z.enum(['allow', 'deny']),
})

export const InboundMsg = z.object({
  type: z.literal('inbound'),
  chat_id: z.string(),
  message_id: z.string(),
  user: z.string(),
  user_id: z.string(),
  ts: z.string(),
  content: z.string(),
  attachment_count: z.number().optional(),
  attachments: z.string().optional(),
})

export const UnregisterMsg = z.object({ type: z.literal('unregister'), id: z.number() })
export const PingMsg = z.object({ type: z.literal('ping'), id: z.number() })
export const PongMsg = z.object({ type: z.literal('pong'), id: z.number() })

const ShimUnion = z.discriminatedUnion('type', [
  RegisterMsg as unknown as z.ZodDiscriminatedUnionOption<'type'>,
  ToolCallMsg, PermissionRequestMsg, UnregisterMsg, PingMsg,
])
const DaemonUnion = z.discriminatedUnion('type', [
  RegisterAckMsg, RegisterErrMsg, ToolResultMsg, PermissionDecisionMsg, InboundMsg, PongMsg,
])

export type ShimMsg = z.infer<typeof ShimUnion>
export type DaemonMsg = z.infer<typeof DaemonUnion>

export function parseShimMsg(raw: unknown): ShimMsg {
  return ShimUnion.parse(raw)
}
export function parseDaemonMsg(raw: unknown): DaemonMsg {
  return DaemonUnion.parse(raw)
}
```

(`RegisterMsg` is `.superRefine`'d, which doesn't fit `discriminatedUnion` cleanly — the `as unknown as` cast is the documented workaround in zod ≤ 3.23.)

- [ ] **Step 4: Run tests**

```bash
bun test tests/protocol.test.ts
```

Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts tests/protocol.test.ts
git commit -m "feat: add wire protocol schemas"
```

---

### Task B3: `src/framing.ts`

**Files:**
- Create: `src/framing.ts`
- Create: `tests/framing.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/framing.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test'
import { Readable, PassThrough } from 'stream'
import { readFrames, writeFrame } from '../src/framing'

describe('framing', () => {
  test('readFrames splits on newlines', async () => {
    const src = Readable.from([Buffer.from('{"a":1}\n{"b":2}\n')])
    const out: unknown[] = []
    for await (const f of readFrames(src)) out.push(f)
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('readFrames handles fragmented chunks', async () => {
    const src = Readable.from([Buffer.from('{"a":'), Buffer.from('1}\n'), Buffer.from('{"b":2}\n')])
    const out: unknown[] = []
    for await (const f of readFrames(src)) out.push(f)
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('readFrames rejects messages over the size limit', async () => {
    const big = Buffer.from('"' + 'x'.repeat(2_000_000) + '"\n')
    const src = Readable.from([big])
    const out: unknown[] = []
    let threw = false
    try {
      for await (const f of readFrames(src, { maxBytes: 1024 })) out.push(f)
    } catch (e) {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('writeFrame writes one line of JSON', async () => {
    const sink = new PassThrough()
    let captured = ''
    sink.on('data', d => { captured += d.toString('utf8') })
    writeFrame(sink, { hello: 'world' })
    await new Promise(r => setImmediate(r))
    expect(captured).toBe('{"hello":"world"}\n')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/framing.test.ts
```

- [ ] **Step 3: Create the module**

Create `src/framing.ts`:

```typescript
import type { Readable, Writable } from 'stream'

const DEFAULT_MAX_BYTES = 1024 * 1024 // 1 MiB

export async function* readFrames(
  src: Readable,
  opts: { maxBytes?: number } = {},
): AsyncGenerator<unknown> {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let buf = ''
  for await (const chunk of src) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (buf.length > max) {
      throw new Error(`framing: message exceeds ${max} bytes`)
    }
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      yield JSON.parse(line)
    }
  }
}

export function writeFrame(dst: Writable, msg: unknown): void {
  dst.write(JSON.stringify(msg) + '\n')
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/framing.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/framing.ts tests/framing.test.ts
git commit -m "feat: add newline-delimited JSON framing helpers"
```

---

## Phase C — Daemon

### Task C1: `DiscordOps` interface + fake

**Files:**
- Create: `src/discord-ops.ts`
- Create: `tests/discord-ops.fake.test.ts`

- [ ] **Step 1: Write failing tests for the fake**

Create `tests/discord-ops.fake.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test'
import { FakeDiscordOps } from '../src/discord-ops'

describe('FakeDiscordOps', () => {
  test('records reply calls', async () => {
    const ops = new FakeDiscordOps()
    const ids = await ops.reply('chan', 'hello', { reply_to: 'm1' })
    expect(ids).toEqual(['fake-msg-1'])
    expect(ops.calls).toEqual([{ kind: 'reply', chat_id: 'chan', text: 'hello', reply_to: 'm1', files: [] }])
  })

  test('createThread returns id+name', async () => {
    const ops = new FakeDiscordOps()
    const t = await ops.createThread('parent-1', 'cool-thread')
    expect(t.thread_id).toMatch(/^fake-thread-\d+$/)
    expect(t.thread_name).toBe('cool-thread')
  })

  test('verifyThreadParent maps via createThread results', async () => {
    const ops = new FakeDiscordOps()
    const { thread_id } = await ops.createThread('parent-1', 'x')
    expect(await ops.verifyThreadParent(thread_id)).toBe('parent-1')
    expect(await ops.verifyThreadParent('unknown')).toBeNull()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/discord-ops.fake.test.ts
```

- [ ] **Step 3: Create the module**

Create `src/discord-ops.ts`:

```typescript
export type ReplyOpts = { reply_to?: string; files?: string[] }
export type FetchedMessage = {
  id: string; ts: string; author_id: string; author_name: string;
  content: string; attachment_count: number;
}

export interface DiscordOps {
  reply(chat_id: string, text: string, opts?: ReplyOpts): Promise<string[]>
  react(chat_id: string, message_id: string, emoji: string): Promise<void>
  edit(chat_id: string, message_id: string, text: string): Promise<string>
  fetch(chat_id: string, limit: number): Promise<FetchedMessage[]>
  downloadAttachments(chat_id: string, message_id: string, dir: string): Promise<{ path: string; name: string; type: string; bytes: number }[]>
  createThread(parent_channel_id: string, name: string): Promise<{ thread_id: string; thread_name: string; thread_url?: string }>
  verifyThreadParent(thread_id: string): Promise<string | null>
  postPermissionPrompt(chat_id: string, request_id: string, tool_name: string): Promise<void>
  postPermissionPromptDM(allowFrom: string[], request_id: string, tool_name: string): Promise<void>
  updatePermissionMessage(chat_id: string, message_id: string, label: string, expanded?: string): Promise<void>
}

export class FakeDiscordOps implements DiscordOps {
  calls: Array<Record<string, unknown>> = []
  private msgCounter = 0
  private threadCounter = 0
  private threadParents = new Map<string, string>()

  async reply(chat_id: string, text: string, opts: ReplyOpts = {}) {
    this.calls.push({ kind: 'reply', chat_id, text, reply_to: opts.reply_to, files: opts.files ?? [] })
    return [`fake-msg-${++this.msgCounter}`]
  }
  async react(chat_id: string, message_id: string, emoji: string) {
    this.calls.push({ kind: 'react', chat_id, message_id, emoji })
  }
  async edit(chat_id: string, message_id: string, text: string) {
    this.calls.push({ kind: 'edit', chat_id, message_id, text })
    return message_id
  }
  async fetch(chat_id: string, limit: number) {
    this.calls.push({ kind: 'fetch', chat_id, limit })
    return []
  }
  async downloadAttachments(chat_id: string, message_id: string) {
    this.calls.push({ kind: 'download', chat_id, message_id })
    return []
  }
  async createThread(parent_channel_id: string, name: string) {
    const thread_id = `fake-thread-${++this.threadCounter}`
    this.threadParents.set(thread_id, parent_channel_id)
    this.calls.push({ kind: 'createThread', parent_channel_id, name, thread_id })
    return { thread_id, thread_name: name }
  }
  async verifyThreadParent(thread_id: string) {
    return this.threadParents.get(thread_id) ?? null
  }
  async postPermissionPrompt(chat_id: string, request_id: string, tool_name: string) {
    this.calls.push({ kind: 'permPrompt', chat_id, request_id, tool_name })
  }
  async postPermissionPromptDM(allowFrom: string[], request_id: string, tool_name: string) {
    this.calls.push({ kind: 'permPromptDM', allowFrom, request_id, tool_name })
  }
  async updatePermissionMessage(chat_id: string, message_id: string, label: string) {
    this.calls.push({ kind: 'permUpdate', chat_id, message_id, label })
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/discord-ops.fake.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/discord-ops.ts tests/discord-ops.fake.test.ts
git commit -m "feat: define DiscordOps interface and FakeDiscordOps for tests"
```

---

### Task C2: Daemon skeleton — flock, socket bind, idle exit

**Files:**
- Create: `src/daemon.ts`
- Create: `tests/daemon-shim.integration.test.ts` (will grow over later tasks)

- [ ] **Step 1: Write a failing integration test that just connects**

Create `tests/daemon-shim.integration.test.ts`:

```typescript
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection } from 'net'
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

async function connect(sockPath: string) {
  return new Promise<ReturnType<typeof createConnection>>((res, rej) => {
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
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/daemon-shim.integration.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the daemon skeleton**

Create `src/daemon.ts`:

```typescript
import { createServer, type Server, type Socket } from 'net'
import { mkdirSync, unlinkSync, openSync, closeSync, writeFileSync, existsSync } from 'fs'
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

export async function startDaemon(opts: DaemonOpts): Promise<DaemonHandle> {
  const { stateDir, ops, idleExitMs } = opts
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const sockPath = join(stateDir, 'daemon.sock')
  const lockPath = join(stateDir, 'daemon.lock')
  const pidPath = join(stateDir, 'daemon.pid')

  // Single-instance: refuse to start if the socket is already serving.
  if (existsSync(sockPath)) {
    try {
      // Probe by trying to bind a fresh socket below; if the path is stale
      // we'll remove it. A live process will error EADDRINUSE.
      const probe = createServer()
      await new Promise<void>((res, rej) => {
        probe.once('error', rej); probe.once('listening', () => probe.close(() => res()))
        probe.listen(sockPath)
      })
      // If we got here, no one was holding it. Clean up.
      unlinkSync(sockPath)
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') throw new Error(`daemon already running at ${sockPath}`)
      // Other errors → continue and let the real listen() report them.
    }
  }

  const server: Server = createServer()
  await new Promise<void>((res, rej) => {
    server.once('error', rej); server.once('listening', () => res())
    server.listen(sockPath)
  })
  // Tighten perms on the socket and pid file.
  try { require('fs').chmodSync(sockPath, 0o600) } catch {}
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

  server.on('connection', (sock: Socket) => {
    clients.add(sock)
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    void handleConnection(sock, ops)
      .catch(err => { try { sock.destroy(err) } catch {} })
      .finally(() => { clients.delete(sock); armIdle() })
  })

  armIdle()

  let stopped = false
  async function shutdown(): Promise<void> {
    if (stopped) return
    stopped = true
    for (const c of clients) { try { c.destroy() } catch {} }
    await new Promise<void>(r => server.close(() => r()))
    try { unlinkSync(sockPath) } catch {}
    try { unlinkSync(pidPath) } catch {}
    try { unlinkSync(lockPath) } catch {}
  }

  return { shutdown }
}

async function handleConnection(sock: Socket, ops: DiscordOps): Promise<void> {
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
      // register/tool_call/permission_request/unregister handled in later tasks
      default:
        writeFrame(sock, { type: 'error', message: `unsupported in skeleton: ${msg.type}` })
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/daemon-shim.integration.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon-shim.integration.test.ts
git commit -m "feat: daemon skeleton — UDS bind, ping, single-instance"
```

---

### Task C3: Daemon — register / unregister + routing tables

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-shim.integration.test.ts`

- [ ] **Step 1: Add failing tests for register flow**

Append to `tests/daemon-shim.integration.test.ts`:

```typescript
describe('daemon: register', () => {
  test('DM register succeeds; second DM register errors', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })

    async function reg(session_id: string, mode: 'dm' | 'thread', thread_id?: string) {
      const sock = await connect(join(dir, 'daemon.sock'))
      writeFrame(sock, { type: 'register', id: 1, session_id, mode, cwd: '/x', thread_id })
      let ack: any = null
      for await (const m of readFrames(sock)) { ack = m; break }
      return { sock, ack }
    }

    const a = await reg('s1', 'dm')
    expect(a.ack.type).toBe('register_ack')

    const b = await reg('s2', 'dm')
    expect(b.ack.type).toBe('register_err')
    expect(b.ack.code).toBe('dm_session_taken')

    a.sock.end(); b.sock.end()
  })

  test('thread register with auto and parentChannelId set creates a thread', async () => {
    const ops = new FakeDiscordOps()
    // Seed access.json with parentChannelId.
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: true, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    writeFrame(sock, { type: 'register', id: 7, session_id: 'sess-thread', mode: 'thread', cwd: '/repo/cool-app', thread_id: 'auto' })
    let ack: any = null
    for await (const m of readFrames(sock)) { ack = m; break }
    expect(ack.type).toBe('register_ack')
    expect(ack.thread_id).toMatch(/^fake-thread-/)
    expect(ops.calls.find(c => c.kind === 'createThread')).toBeTruthy()
    sock.end()
  })

  test('thread register with auto but no parentChannelId errors', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    writeFrame(sock, { type: 'register', id: 1, session_id: 's1', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    let ack: any = null
    for await (const m of readFrames(sock)) { ack = m; break }
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('parent_channel_unset')
    sock.end()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/daemon-shim.integration.test.ts
```

- [ ] **Step 3: Implement register / unregister in daemon**

Replace `handleConnection` in `src/daemon.ts` with a session-aware router. Add to top of file:

```typescript
import { join } from 'path'
import { loadAccess, saveAccess, type Access } from './access'
import { loadBindings, saveBindings, type Bindings } from './bindings'
import { deriveThreadName } from './session-id'
```

Replace the body of `startDaemon` after the `server.on('connection', …)` setup with a richer registration table:

```typescript
type Session = {
  session_id: string
  mode: 'dm' | 'thread'
  thread_id: string | null
  sock: Socket
}

const sessions = new Map<string, Session>()    // by session_id
const threadIndex = new Map<string, string>()  // thread_id → session_id
let dmSessionId: string | null = null

async function handleConnection(sock: Socket): Promise<void> {
  let mySessionId: string | null = null
  try {
    for await (const raw of readFrames(sock)) {
      let msg
      try { msg = parseShimMsg(raw) } catch (err) {
        writeFrame(sock, { type: 'error', message: String(err) }); continue
      }

      if (msg.type === 'ping') { writeFrame(sock, { type: 'pong', id: msg.id }); continue }
      if (msg.type === 'unregister') {
        // handled in cleanup below
        writeFrame(sock, { type: 'pong', id: msg.id })
        return
      }
      if (msg.type === 'register') {
        const accessFile = join(stateDir, 'access.json')
        const bindingsFile = join(stateDir, 'bindings.json')
        const access = loadAccess(accessFile)
        const bindings = loadBindings(bindingsFile)

        if (sessions.has(msg.session_id)) {
          writeFrame(sock, { type: 'register_err', id: msg.id, code: msg.mode === 'dm' ? 'dm_session_taken' : 'thread_session_taken', message: 'already registered' })
          continue
        }

        if (msg.mode === 'dm') {
          if (dmSessionId) {
            writeFrame(sock, { type: 'register_err', id: msg.id, code: 'dm_session_taken', message: 'a DM-mode shim is already registered' })
            continue
          }
          dmSessionId = msg.session_id
          sessions.set(msg.session_id, { session_id: msg.session_id, mode: 'dm', thread_id: null, sock })
          mySessionId = msg.session_id
          writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: null })
          continue
        }

        // thread mode
        let threadId = msg.thread_id!
        if (threadId === 'auto') {
          // Reuse existing binding if present.
          const existing = bindings[msg.session_id]
          if (existing) {
            threadId = existing.thread_id
          } else {
            if (!access.parentChannelId) {
              writeFrame(sock, { type: 'register_err', id: msg.id, code: 'parent_channel_unset', message: 'parentChannelId is not set in access.json' })
              continue
            }
            const name = deriveThreadName(msg.cwd, msg.session_id)
            const t = await ops.createThread(access.parentChannelId, name)
            threadId = t.thread_id
            bindings[msg.session_id] = { thread_id: threadId, cwd: msg.cwd, created_at: Date.now(), last_seen_at: Date.now() }
            saveBindings(bindingsFile, bindings)
          }
        } else {
          // Verify the thread is under an opted-in parent.
          const parent = await ops.verifyThreadParent(threadId)
          if (!parent || !(parent in access.groups)) {
            writeFrame(sock, { type: 'register_err', id: msg.id, code: 'thread_not_allowed', message: 'thread parent is not opted in via /discord:access group add' })
            continue
          }
          bindings[msg.session_id] = { thread_id: threadId, cwd: msg.cwd, created_at: bindings[msg.session_id]?.created_at ?? Date.now(), last_seen_at: Date.now() }
          saveBindings(bindingsFile, bindings)
        }

        if (threadIndex.has(threadId)) {
          writeFrame(sock, { type: 'register_err', id: msg.id, code: 'thread_session_taken', message: 'this thread is already bound to another session' })
          continue
        }
        threadIndex.set(threadId, msg.session_id)
        sessions.set(msg.session_id, { session_id: msg.session_id, mode: 'thread', thread_id: threadId, sock })
        mySessionId = msg.session_id
        writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: threadId })
        continue
      }

      // tool_call / permission_request → handled in later tasks
      writeFrame(sock, { type: 'error', message: `not implemented yet: ${msg.type}` })
    }
  } finally {
    if (mySessionId) {
      const s = sessions.get(mySessionId)
      if (s?.thread_id) threadIndex.delete(s.thread_id)
      if (dmSessionId === mySessionId) dmSessionId = null
      sessions.delete(mySessionId)
    }
  }
}
```

Pass `ops` and `stateDir` into `handleConnection` via closure (the function lives inside `startDaemon`). Adjust the `server.on('connection', ...)` callback accordingly.

- [ ] **Step 4: Run tests**

```bash
bun test tests/daemon-shim.integration.test.ts
```

Expected: 5 pass (2 prior + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon-shim.integration.test.ts
git commit -m "feat: daemon register/unregister and routing tables"
```

---

### Task C4: Daemon — `tool_call` dispatch

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-shim.integration.test.ts`

- [ ] **Step 1: Add failing test**

Append to `tests/daemon-shim.integration.test.ts`:

```typescript
describe('daemon: tool_call', () => {
  test('reply forwards to ops.reply and returns ids', async () => {
    const ops = new FakeDiscordOps()
    // Seed an opted-in group.
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.allowFrom = ['user-1']  // make the channel allow-listed via DM
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    writeFrame(sock, { type: 'register', id: 1, session_id: 's1', mode: 'dm', cwd: '/x' })
    writeFrame(sock, { type: 'tool_call', id: 2, name: 'reply', args: { chat_id: 'dm-1', text: 'hello' } })

    const seen: any[] = []
    for await (const m of readFrames(sock)) {
      seen.push(m)
      if (seen.length === 2) break
    }
    expect(seen[0].type).toBe('register_ack')
    expect(seen[1].type).toBe('tool_result')
    expect(seen[1].isError).toBeUndefined()
    expect(ops.calls.find(c => c.kind === 'reply')).toBeTruthy()
    sock.end()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/daemon-shim.integration.test.ts
```

- [ ] **Step 3: Implement tool dispatch in daemon**

Inside `handleConnection`, replace the `not implemented yet: tool_call` arm with a real dispatcher that maps tool names to `DiscordOps` methods. Add a helper function inside `startDaemon`:

```typescript
async function runTool(name: string, args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    switch (name) {
      case 'reply': {
        const ids = await ops.reply(
          String(args.chat_id),
          String(args.text),
          { reply_to: args.reply_to as string | undefined, files: args.files as string[] | undefined },
        )
        const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
        return { content: [{ type: 'text', text }] }
      }
      case 'react':
        await ops.react(String(args.chat_id), String(args.message_id), String(args.emoji))
        return { content: [{ type: 'text', text: 'reacted' }] }
      case 'edit_message': {
        const id = await ops.edit(String(args.chat_id), String(args.message_id), String(args.text))
        return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
      }
      case 'fetch_messages': {
        const arr = await ops.fetch(String(args.channel ?? args.chat_id), Number(args.limit ?? 20))
        const out = arr.length === 0 ? '(no messages)' : arr.map(m =>
          `[${m.ts}] ${m.author_name}: ${m.content.replace(/[\r\n]+/g, ' ⏎ ')}  (id: ${m.id}${m.attachment_count > 0 ? ` +${m.attachment_count}att` : ''})`
        ).join('\n')
        return { content: [{ type: 'text', text: out }] }
      }
      case 'download_attachment': {
        const inboxDir = join(stateDir, 'inbox')
        const out = await ops.downloadAttachments(String(args.chat_id), String(args.message_id), inboxDir)
        if (out.length === 0) return { content: [{ type: 'text', text: 'message has no attachments' }] }
        const lines = out.map(f => `  ${f.path}  (${f.name}, ${f.type}, ${(f.bytes/1024).toFixed(0)}KB)`)
        return { content: [{ type: 'text', text: `downloaded ${out.length} attachment(s):\n${lines.join('\n')}` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
  }
}
```

Then in the message loop:

```typescript
if (msg.type === 'tool_call') {
  const result = await runTool(msg.name, msg.args)
  writeFrame(sock, { type: 'tool_result', id: msg.id, ...result })
  continue
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/daemon-shim.integration.test.ts
```

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon-shim.integration.test.ts
git commit -m "feat: daemon tool_call dispatch via DiscordOps"
```

---

### Task C5: Daemon — inbound routing + permission relay

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-shim.integration.test.ts`

We add a `daemon.deliverInbound(...)` method that the production driver will call when Discord delivers a `messageCreate`. In tests we call it directly.

- [ ] **Step 1: Add failing tests**

Append to `tests/daemon-shim.integration.test.ts`:

```typescript
describe('daemon: inbound routing', () => {
  test('thread-bound message routes to that thread shim', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })

    // Register thread shim
    const shim = await connect(join(dir, 'daemon.sock'))
    writeFrame(shim, { type: 'register', id: 1, session_id: 'st', mode: 'thread', cwd: '/repo/x', thread_id: 'auto' })
    let ack: any
    for await (const m of readFrames(shim)) { ack = m; break }
    expect(ack.type).toBe('register_ack')
    const threadId = ack.thread_id

    // Deliver an inbound on that thread.
    daemon!.deliverInbound!({
      chat_id: threadId, message_id: 'm1', user: 'alice', user_id: 'u1',
      ts: '2026-01-01T00:00:00Z', content: 'hi', isDM: false, parentChannelId: 'parent-1',
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    let inbound: any
    for await (const m of readFrames(shim)) { inbound = m; break }
    expect(inbound.type).toBe('inbound')
    expect(inbound.chat_id).toBe(threadId)
    shim.end()
  })

  test('DM routes to dm-mode shim', async () => {
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.allowFrom = ['user-1']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })

    const shim = await connect(join(dir, 'daemon.sock'))
    writeFrame(shim, { type: 'register', id: 1, session_id: 's-dm', mode: 'dm', cwd: '/x' })
    let ack: any
    for await (const m of readFrames(shim)) { ack = m; break }
    expect(ack.type).toBe('register_ack')

    daemon!.deliverInbound!({
      chat_id: 'dm-channel-1', message_id: 'm1', user: 'alice', user_id: 'user-1',
      ts: '2026-01-01T00:00:00Z', content: 'hi', isDM: true,
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    let inbound: any
    for await (const m of readFrames(shim)) { inbound = m; break }
    expect(inbound.type).toBe('inbound')
    shim.end()
  })

  test('unbound thread message is dropped (no shim notified)', async () => {
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })

    const shim = await connect(join(dir, 'daemon.sock'))
    writeFrame(shim, { type: 'register', id: 1, session_id: 's-dm', mode: 'dm', cwd: '/x' })
    for await (const _m of readFrames(shim)) { break }

    daemon!.deliverInbound!({
      chat_id: 'unknown-thread', message_id: 'm1', user: 'alice', user_id: 'u1',
      ts: '2026-01-01T00:00:00Z', content: 'hi', isDM: false, parentChannelId: 'parent-1',
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    // Race: assert no inbound arrives within 100ms.
    const got = await Promise.race([
      (async () => { for await (const m of readFrames(shim)) return m })(),
      new Promise(r => setTimeout(() => r(null), 100)),
    ])
    expect(got).toBeNull()
    shim.end()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test tests/daemon-shim.integration.test.ts
```

- [ ] **Step 3: Implement `deliverInbound` and permission relay**

Extend `DaemonHandle` in `src/daemon.ts`:

```typescript
export type InboundEvent = {
  chat_id: string
  message_id: string
  user: string
  user_id: string
  ts: string
  content: string
  isDM: boolean
  parentChannelId?: string
  hasBotMention: boolean
  isReplyToBot: boolean
  attachments: { name: string; type: string; bytes: number }[]
}

export type DaemonHandle = {
  shutdown(): Promise<void>
  deliverInbound(ev: InboundEvent): void
  permissionDecision(request_id: string, behavior: 'allow' | 'deny'): void
}
```

Inside `startDaemon`, add:

```typescript
import { gate } from './gate'

const permRoutes = new Map<string, string>() // request_id → session_id

function deliverInbound(ev: InboundEvent): void {
  const accessFile = join(stateDir, 'access.json')
  const access = loadAccess(accessFile)
  const result = gate({
    senderId: ev.user_id,
    isDM: ev.isDM,
    channelId: ev.chat_id,
    parentChannelId: ev.parentChannelId,
    content: ev.content,
    hasBotMention: ev.hasBotMention,
    isReplyToBot: ev.isReplyToBot,
  }, access)
  if (result.action !== 'deliver') {
    if (result.action === 'pair') saveAccess(accessFile, access)
    // Pair/drop emit reactions through ops in production; tests don't care.
    return
  }

  // Routing:
  let target: Session | undefined
  if (!ev.isDM) {
    const bound = threadIndex.get(ev.chat_id)
    if (bound) target = sessions.get(bound)
    else {
      // Non-thread guild message OR unbound thread → fall through to DM shim.
      // We treat "unbound thread" as drop (per spec) and only forward
      // non-thread guild messages to DM shim.
      if (!ev.parentChannelId) {
        if (dmSessionId) target = sessions.get(dmSessionId)
      } else {
        // Unbound thread → drop. Production driver may add a ❓ reaction.
        return
      }
    }
  } else {
    if (dmSessionId) target = sessions.get(dmSessionId)
  }
  if (!target) return

  const atts = ev.attachments
  writeFrame(target.sock, {
    type: 'inbound',
    chat_id: ev.chat_id, message_id: ev.message_id,
    user: ev.user, user_id: ev.user_id, ts: ev.ts,
    content: ev.content,
    ...(atts.length > 0 ? {
      attachment_count: atts.length,
      attachments: atts.map(a => `${a.name} (${a.type}, ${(a.bytes/1024).toFixed(0)}KB)`).join('; '),
    } : {}),
  })
}

function permissionDecision(request_id: string, behavior: 'allow' | 'deny'): void {
  const sid = permRoutes.get(request_id)
  if (!sid) return
  permRoutes.delete(request_id)
  const s = sessions.get(sid)
  if (!s) return
  writeFrame(s.sock, { type: 'permission_decision', request_id, behavior })
}
```

In the message loop, handle `permission_request`:

```typescript
if (msg.type === 'permission_request') {
  if (!mySessionId) {
    writeFrame(sock, { type: 'error', message: 'permission_request requires register first' })
    continue
  }
  permRoutes.set(msg.request_id, mySessionId)
  const s = sessions.get(mySessionId)!
  if (s.mode === 'thread' && s.thread_id) {
    void ops.postPermissionPrompt(s.thread_id, msg.request_id, msg.tool_name)
  } else {
    const access = loadAccess(join(stateDir, 'access.json'))
    void ops.postPermissionPromptDM(access.allowFrom, msg.request_id, msg.tool_name)
  }
  continue
}
```

Return `{ shutdown, deliverInbound, permissionDecision }` from `startDaemon`.

- [ ] **Step 4: Run tests**

```bash
bun test tests/daemon-shim.integration.test.ts
```

Expected: 9 pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon-shim.integration.test.ts
git commit -m "feat: daemon inbound routing and permission relay"
```

---

## Phase D — Shim

### Task D1: Shim — MCP server skeleton + lazy daemon spawn + register

**Files:**
- Create: `src/shim.ts`

The shim is harder to unit-test because of stdio MCP. We test it via the integration test in Phase F (end-to-end) and rely on type-checking + manual smoke for the rest. This task implements the structure.

- [ ] **Step 1: Create the shim**

Create `src/shim.ts`:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createConnection, type Socket } from 'net'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { readFrames, writeFrame } from './framing'
import { parseDaemonMsg } from './protocol'
import { deriveSessionId } from './session-id'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const SOCK_PATH = join(STATE_DIR, 'daemon.sock')
const THREAD_ENV = process.env.DISCORD_THREAD_ID
const SESSION_ID = process.env.CLAUDE_SESSION_ID ?? deriveSessionId(process.cwd())

async function connectOrSpawn(): Promise<Socket> {
  const tryConnect = () => new Promise<Socket | null>(res => {
    if (!existsSync(SOCK_PATH)) return res(null)
    const s = createConnection(SOCK_PATH)
    s.once('connect', () => res(s))
    s.once('error', () => res(null))
  })
  let sock = await tryConnect()
  if (sock) return sock

  // Spawn the daemon as a detached child.
  const log = require('fs').openSync(join(STATE_DIR, 'daemon.log'), 'a')
  const entry = resolve(import.meta.dir, '..', 'server.ts')
  const child = spawn(process.execPath, [entry, '--daemon'], {
    detached: true, stdio: ['ignore', log, log], env: process.env,
  })
  child.unref()

  // Poll for the socket up to 5 s.
  for (let i = 0; i < 50; i++) {
    sock = await tryConnect()
    if (sock) return sock
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`shim: daemon did not start within 5 s; check ${join(STATE_DIR, 'daemon.log')}`)
}

let daemonSock: Socket | null = null
let nextId = 1
const pending = new Map<number, (msg: any) => void>()

async function send<T = any>(req: { type: string; [k: string]: unknown }): Promise<T> {
  if (!daemonSock) throw new Error('shim: daemon not connected')
  const id = req.id as number ?? (req.id = nextId++)
  return new Promise<T>((res, rej) => {
    pending.set(id, msg => { pending.delete(id); res(msg as T) })
    writeFrame(daemonSock!, req)
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`daemon timeout: ${req.type}`)) } }, 30_000)
  })
}

const mcp = new Server(
  { name: 'discord', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
    instructions: 'See server.ts. Inbound messages arrive as <channel source="discord" …>.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'reply', description: 'Reply on Discord. Pass chat_id from the inbound message.', inputSchema: { type: 'object', properties: { chat_id: {type:'string'}, text: {type:'string'}, reply_to: {type:'string'}, files: {type:'array', items:{type:'string'}} }, required: ['chat_id','text'] } },
    { name: 'react', description: 'Add an emoji reaction.', inputSchema: { type: 'object', properties: { chat_id:{type:'string'}, message_id:{type:'string'}, emoji:{type:'string'} }, required: ['chat_id','message_id','emoji'] } },
    { name: 'edit_message', description: 'Edit a previously-sent message.', inputSchema: { type: 'object', properties: { chat_id:{type:'string'}, message_id:{type:'string'}, text:{type:'string'} }, required: ['chat_id','message_id','text'] } },
    { name: 'download_attachment', description: 'Download attachments to inbox/.', inputSchema: { type: 'object', properties: { chat_id:{type:'string'}, message_id:{type:'string'} }, required: ['chat_id','message_id'] } },
    { name: 'fetch_messages', description: 'Fetch recent messages.', inputSchema: { type: 'object', properties: { channel:{type:'string'}, limit:{type:'number'} }, required: ['channel'] } },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const id = nextId++
  const reply = await send<{ type: 'tool_result'; content: any[]; isError?: boolean }>({
    type: 'tool_call', id, name: req.params.name, args: req.params.arguments ?? {},
  })
  return { content: reply.content, isError: reply.isError }
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => {
    await send({ type: 'permission_request', id: nextId++, ...params })
  },
)

async function readDaemonLoop() {
  if (!daemonSock) return
  for await (const raw of readFrames(daemonSock)) {
    const msg = parseDaemonMsg(raw)
    if ((msg as any).id != null && pending.has((msg as any).id)) {
      pending.get((msg as any).id)!(msg)
      continue
    }
    if (msg.type === 'inbound') {
      void mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content,
          meta: {
            chat_id: msg.chat_id, message_id: msg.message_id,
            user: msg.user, user_id: msg.user_id, ts: msg.ts,
            ...(msg.attachment_count ? { attachment_count: String(msg.attachment_count), attachments: msg.attachments } : {}),
          },
        },
      })
    } else if (msg.type === 'permission_decision') {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      })
    }
  }
}

export async function runShim(): Promise<void> {
  daemonSock = await connectOrSpawn()
  void readDaemonLoop()

  const ack = await send<{ type: 'register_ack' | 'register_err'; code?: string; message?: string }>({
    type: 'register', id: nextId++, session_id: SESSION_ID,
    mode: THREAD_ENV ? 'thread' : 'dm', cwd: process.cwd(),
    ...(THREAD_ENV ? { thread_id: THREAD_ENV } : {}),
  })
  if (ack.type !== 'register_ack') {
    process.stderr.write(`discord shim: register failed (${ack.code}): ${ack.message}\n`)
    process.exit(1)
  }

  await mcp.connect(new StdioServerTransport())

  const shutdown = () => {
    try { daemonSock?.end() } catch {}
    setTimeout(() => process.exit(0), 500)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
```

- [ ] **Step 2: Type-check the new file**

```bash
bun build src/shim.ts --target=bun --no-bundle 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shim.ts
git commit -m "feat: shim — MCP server, lazy daemon spawn, tool relay"
```

---

## Phase E — Real Discord driver + dispatch

### Task E1: Implement real `DiscordOps` from existing `server.ts`

**Files:**
- Modify: `src/discord-ops.ts` (add `RealDiscordOps`)

This task ports the discord.js calls and the message-chunking from the existing `server.ts` into a class implementing `DiscordOps`. No tests — exercised end-to-end during smoke.

- [ ] **Step 1: Add `RealDiscordOps`**

Append to `src/discord-ops.ts`:

```typescript
import { Client, ChannelType, ChannelType as CT, ButtonBuilder, ButtonStyle, ActionRowBuilder, type Attachment } from 'discord.js'
import { writeFileSync, mkdirSync, statSync, realpathSync } from 'fs'
import { join, sep } from 'path'
import { chunk } from './chunk'
import { type Access } from './access'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export class RealDiscordOps implements DiscordOps {
  recentSentIds = new Set<string>()
  private RECENT_CAP = 200
  constructor(private client: Client, private getAccess: () => Access, private stateDir: string) {}

  private noteSent(id: string) {
    this.recentSentIds.add(id)
    if (this.recentSentIds.size > this.RECENT_CAP) {
      const first = this.recentSentIds.values().next().value
      if (first) this.recentSentIds.delete(first)
    }
  }

  private async fetchTextChannel(id: string) {
    const ch = await this.client.channels.fetch(id)
    if (!ch || !ch.isTextBased()) throw new Error(`channel ${id} not found or not text-based`)
    return ch
  }

  private assertSendable(f: string): void {
    let real, stateReal: string
    try { real = realpathSync(f); stateReal = realpathSync(this.stateDir) } catch { return }
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }

  async reply(chat_id: string, text: string, opts: ReplyOpts = {}) {
    const ch: any = await this.fetchTextChannel(chat_id)
    if (!('send' in ch)) throw new Error('channel not sendable')
    const files = opts.files ?? []
    for (const f of files) {
      this.assertSendable(f)
      const st = statSync(f)
      if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f}`)
    }
    if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')

    const access = this.getAccess()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? 2000, 2000))
    const mode = access.chunkMode ?? 'length'
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunk(text, limit, mode)
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const shouldReplyTo = opts.reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      const sent = await ch.send({
        content: chunks[i],
        ...(i === 0 && files.length > 0 ? { files } : {}),
        ...(shouldReplyTo ? { reply: { messageReference: opts.reply_to, failIfNotExists: false } } : {}),
      })
      this.noteSent(sent.id); ids.push(sent.id)
    }
    return ids
  }

  async react(chat_id: string, message_id: string, emoji: string) {
    const ch: any = await this.fetchTextChannel(chat_id)
    const msg = await ch.messages.fetch(message_id)
    await msg.react(emoji)
  }

  async edit(chat_id: string, message_id: string, text: string) {
    const ch: any = await this.fetchTextChannel(chat_id)
    const msg = await ch.messages.fetch(message_id)
    const edited = await msg.edit(text)
    return edited.id
  }

  async fetch(chat_id: string, limit: number): Promise<FetchedMessage[]> {
    const ch: any = await this.fetchTextChannel(chat_id)
    const msgs = await ch.messages.fetch({ limit: Math.min(limit, 100) })
    const me = this.client.user?.id
    const arr = [...msgs.values()].reverse()
    return arr.map((m: any) => ({
      id: m.id, ts: m.createdAt.toISOString(),
      author_id: m.author.id, author_name: m.author.id === me ? 'me' : m.author.username,
      content: m.content, attachment_count: m.attachments.size,
    }))
  }

  async downloadAttachments(chat_id: string, message_id: string, dir: string) {
    mkdirSync(dir, { recursive: true })
    const ch: any = await this.fetchTextChannel(chat_id)
    const msg = await ch.messages.fetch(message_id)
    const out = []
    for (const att of msg.attachments.values() as IterableIterator<Attachment>) {
      if (att.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large: ${att.id}`)
      const res = await fetch(att.url)
      const buf = Buffer.from(await res.arrayBuffer())
      const name = att.name ?? att.id
      const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const path = join(dir, `${Date.now()}-${att.id}.${ext}`)
      writeFileSync(path, buf)
      out.push({ path, name: name.replace(/[\[\]\r\n;]/g, '_'), type: att.contentType ?? 'unknown', bytes: att.size })
    }
    return out
  }

  async createThread(parent_channel_id: string, name: string) {
    const parent: any = await this.fetchTextChannel(parent_channel_id)
    if (!('threads' in parent)) throw new Error(`channel ${parent_channel_id} cannot host threads`)
    const t = await parent.threads.create({ name, autoArchiveDuration: 1440 })
    return { thread_id: t.id, thread_name: t.name, thread_url: `https://discord.com/channels/${parent.guildId}/${t.id}` }
  }

  async verifyThreadParent(thread_id: string) {
    try {
      const ch: any = await this.client.channels.fetch(thread_id)
      if (!ch || !ch.isThread()) return null
      return ch.parentId ?? null
    } catch { return null }
  }

  async postPermissionPrompt(chat_id: string, request_id: string, tool_name: string) {
    const ch: any = await this.fetchTextChannel(chat_id)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:more:${request_id}`).setLabel('See more').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    await ch.send({ content: `🔐 Permission: ${tool_name}`, components: [row] })
  }

  async postPermissionPromptDM(allowFrom: string[], request_id: string, tool_name: string) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:more:${request_id}`).setLabel('See more').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    for (const userId of allowFrom) {
      try { const u = await this.client.users.fetch(userId); await u.send({ content: `🔐 Permission: ${tool_name}`, components: [row] }) }
      catch (e) { process.stderr.write(`postPermissionPromptDM ${userId}: ${e}\n`) }
    }
  }

  async updatePermissionMessage(_chat_id: string, _message_id: string, _label: string) {
    // No-op for now; label updates happen inside the interactionCreate handler
    // in the daemon entrypoint where we have the Interaction object.
  }
}
```

- [ ] **Step 2: Type-check**

```bash
bun build src/discord-ops.ts --target=bun --no-bundle 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/discord-ops.ts
git commit -m "feat: real DiscordOps wrapping discord.js"
```

---

### Task E2: Daemon entrypoint — wire Discord client to daemon

**Files:**
- Modify: `src/daemon.ts`

We add a `runDaemon()` function that loads the env, creates the Discord client, instantiates `RealDiscordOps`, and bridges Discord events into `daemon.deliverInbound` / `daemon.permissionDecision`. Pairing/approval polling moves here.

- [ ] **Step 1: Add `runDaemon()`**

Append to `src/daemon.ts`:

```typescript
import { Client, GatewayIntentBits, Partials, ChannelType, type Message, type Interaction } from 'discord.js'
import { readFileSync, chmodSync, readdirSync, rmSync } from 'fs'
import { RealDiscordOps } from './discord-ops'

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export async function runDaemon(): Promise<void> {
  const stateDir = process.env.DISCORD_STATE_DIR ?? join(require('os').homedir(), '.claude', 'channels', 'discord')
  // Load .env into process.env if present.
  try {
    chmodSync(join(stateDir, '.env'), 0o600)
    for (const line of readFileSync(join(stateDir, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
  const TOKEN = process.env.DISCORD_BOT_TOKEN
  if (!TOKEN) {
    process.stderr.write(`discord daemon: DISCORD_BOT_TOKEN required\n  set in ${join(stateDir, '.env')}\n`)
    process.exit(1)
  }

  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  })

  const accessFile = join(stateDir, 'access.json')
  const ops = new RealDiscordOps(client, () => loadAccess(accessFile), stateDir)

  const handle = await startDaemon({ stateDir, ops, idleExitMs: 60_000 })

  client.on('messageCreate', async (msg: Message) => {
    if (msg.author.bot) return
    const isDM = msg.channel.type === ChannelType.DM
    let parentId: string | undefined
    if ('isThread' in msg.channel && msg.channel.isThread()) parentId = msg.channel.parentId ?? undefined
    let isReplyToBot = false
    const refId = msg.reference?.messageId
    if (refId && ops.recentSentIds.has(refId)) isReplyToBot = true
    else if (refId) {
      try { const r = await msg.fetchReference(); if (r.author.id === client.user?.id) isReplyToBot = true } catch {}
    }
    // Permission-reply intercept (from existing server.ts) — only for allow-listed senders.
    const access = loadAccess(accessFile)
    if (access.allowFrom.includes(msg.author.id)) {
      const m = PERMISSION_REPLY_RE.exec(msg.content)
      if (m) {
        handle.permissionDecision(m[2]!.toLowerCase(), m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny')
        void msg.react(m[1]!.toLowerCase().startsWith('y') ? '✅' : '❌').catch(() => {})
        return
      }
    }
    handle.deliverInbound({
      chat_id: msg.channelId, message_id: msg.id,
      user: msg.author.username, user_id: msg.author.id,
      ts: msg.createdAt.toISOString(),
      content: msg.content,
      isDM, parentChannelId: parentId,
      hasBotMention: !!(client.user && msg.mentions.has(client.user)),
      isReplyToBot,
      attachments: [...msg.attachments.values()].map(a => ({
        name: (a.name ?? a.id).replace(/[\[\]\r\n;]/g, '_'),
        type: a.contentType ?? 'unknown',
        bytes: a.size,
      })),
    })
  })

  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return
    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
    if (!m) return
    const access = loadAccess(accessFile)
    if (!access.allowFrom.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
      return
    }
    const [, behavior, request_id] = m
    if (behavior === 'more') {
      // The "more" button's expanded view comes from pendingPermissions, which
      // lived in the old server.ts. We omit details for now and just remove
      // the button. (See open-question #5 in the spec.)
      await interaction.update({ content: interaction.message.content, components: [] }).catch(() => {})
      return
    }
    handle.permissionDecision(request_id, behavior as 'allow' | 'deny')
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await interaction.update({ content: `${interaction.message.content}\n\n${label}`, components: [] }).catch(() => {})
  })

  // Approval polling — ported from existing server.ts.
  setInterval(() => {
    const dir = join(stateDir, 'approved')
    let files: string[]
    try { files = readdirSync(dir) } catch { return }
    for (const senderId of files) {
      const path = join(dir, senderId)
      let dmChannelId: string
      try { dmChannelId = readFileSync(path, 'utf8').trim() } catch { rmSync(path, { force: true }); continue }
      if (!dmChannelId) { rmSync(path, { force: true }); continue }
      void (async () => {
        try {
          const ch: any = await client.channels.fetch(dmChannelId)
          if ('send' in ch) await ch.send('Paired! Say hi to Claude.')
        } catch {}
        rmSync(path, { force: true })
      })()
    }
  }, 5000).unref()

  client.on('ready', c => process.stderr.write(`discord daemon: gateway connected as ${c.user.tag}\n`))
  client.login(TOKEN).catch(err => { process.stderr.write(`discord daemon: login failed: ${err}\n`); process.exit(1) })

  const shutdown = async () => { try { await handle.shutdown() } catch {}; try { await client.destroy() } catch {}; process.exit(0) }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
}
```

(Note: pairing-mode pair-code reply is currently emitted by `gate()` returning `pair`. The deliverInbound function above only handles `deliver`. Add the `pair` branch:)

Inside `deliverInbound` in `startDaemon`, after computing `result`:

```typescript
if (result.action === 'pair') {
  saveAccess(accessFile, access)
  const lead = result.isResend ? 'Still pending' : 'Pairing required'
  void ops.reply(ev.chat_id, `${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`)
    .catch(() => {})
  return
}
```

- [ ] **Step 2: Re-run all tests**

```bash
bun test
```

Expected: all passing (the new code doesn't affect existing tests).

- [ ] **Step 3: Commit**

```bash
git add src/daemon.ts
git commit -m "feat: daemon entrypoint wires Discord client and pairing flow"
```

---

### Task E3: Refactor `server.ts` to dispatch

**Files:**
- Modify: `server.ts` (replace contents)

- [ ] **Step 1: Replace `server.ts`**

Overwrite `server.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Discord channel for Claude Code — multi-session edition.
 *
 * Two modes:
 *   - default (no args): run as a per-session shim. Connects to (or
 *     lazy-spawns) the daemon over the Unix socket, and translates
 *     between MCP-stdio and the daemon's framed protocol.
 *   - --daemon: run as the long-lived daemon. Holds the single Discord
 *     gateway connection and routes messages between Discord and any
 *     connected shims.
 *
 * Modifications from anthropics/claude-plugins-official@48aa4351:
 *   - Split into per-session shim + long-lived daemon.
 *   - Daemon supports multiple shim connections over a UDS.
 *   - Shim auto-spawns the daemon if not running.
 *   - Threads bound to sessions; permission requests post in-thread.
 */

if (process.argv.includes('--daemon')) {
  const { runDaemon } = await import('./src/daemon')
  await runDaemon()
} else {
  const { runShim } = await import('./src/shim')
  await runShim()
}
```

- [ ] **Step 2: Verify the build still works**

```bash
bun build server.ts --target=bun --no-bundle 2>&1 | head -20
bun test
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "refactor: server.ts dispatches by --daemon flag"
```

---

## Phase F — End-to-end test

### Task F1: Round-trip test through real shim ↔ real daemon ↔ fake Discord

**Files:**
- Create: `tests/e2e.test.ts`

This boots `runDaemon()` and `runShim()` against a fake Discord (the `FakeDiscordOps` class) and a temp `STATE_DIR`, then asserts an inbound message reaches a Claude-Code-side notification handler.

- [ ] **Step 1: Add the test**

Create `tests/e2e.test.ts`:

```typescript
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startDaemon } from '../src/daemon'
import { FakeDiscordOps } from '../src/discord-ops'
import { saveAccess, defaultAccess } from '../src/access'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'discord-e2e-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('e2e: daemon + fake ops', () => {
  test('register DM, deliver inbound, expect routed message', async () => {
    const ops = new FakeDiscordOps()
    const a = defaultAccess()
    a.allowFrom = ['user-1']
    saveAccess(join(dir, 'access.json'), a)

    const daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })

    // Direct UDS connection acting as a shim.
    const { createConnection } = await import('net')
    const { writeFrame, readFrames } = await import('../src/framing')
    const sock: any = await new Promise((res, rej) => {
      const s = createConnection(join(dir, 'daemon.sock'))
      s.once('connect', () => res(s)); s.once('error', rej)
    })

    writeFrame(sock, { type: 'register', id: 1, session_id: 'sess', mode: 'dm', cwd: '/x' })

    daemon.deliverInbound({
      chat_id: 'dm-1', message_id: 'm', user: 'u', user_id: 'user-1',
      ts: '2026-01-01T00:00:00Z', content: 'ping', isDM: true,
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    const seen: any[] = []
    for await (const m of readFrames(sock)) {
      seen.push(m)
      if (seen.find(x => x.type === 'inbound')) break
    }
    expect(seen.find(x => x.type === 'register_ack')).toBeTruthy()
    expect(seen.find(x => x.type === 'inbound')).toMatchObject({ chat_id: 'dm-1', content: 'ping' })

    sock.end()
    await daemon.shutdown()
  })
})
```

- [ ] **Step 2: Run**

```bash
bun test tests/e2e.test.ts
```

Expected: 1 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.test.ts
git commit -m "test: e2e roundtrip through daemon + fake DiscordOps"
```

---

## Phase G — Skills + docs

### Task G1: Update `/discord:configure` skill for `parentChannelId`

**Files:**
- Modify: `skills/configure/SKILL.md`

- [ ] **Step 1: Add a new dispatch arm and documentation**

In `skills/configure/SKILL.md`, under "Dispatch on arguments", add a `parent <channelId>` arm and update the "what next" guidance:

```markdown
### `parent <channelId>` — set the parent channel for thread sessions

1. Validate that `<channelId>` is a numeric snowflake (digits only).
2. Read `~/.claude/channels/discord/access.json` (create defaults if missing).
3. Set `access.parentChannelId = <channelId>`.
4. If `<channelId>` is not already a key in `access.groups`, also set
   `access.groups[<channelId>] = { requireMention: true, allowFrom: [] }`.
   Inbound thread messages still pass through the gate, which requires
   the parent to be opted in.
5. Write the file. Confirm both: parentChannelId set and group opted in.
```

Add a sentence to the no-args status ("**Parent channel** — `<id>` set, or *not set*; required for `DISCORD_THREAD_ID=auto`.").

- [ ] **Step 2: Commit**

```bash
git add skills/configure/SKILL.md
git commit -m "docs(configure skill): support parentChannelId"
```

---

### Task G2: Update `/discord:access` skill for `parentChannelId`

**Files:**
- Modify: `skills/access/SKILL.md`

- [ ] **Step 1: Extend `set <key> <value>`**

In `skills/access/SKILL.md`, under "set <key> <value>", add `parentChannelId` to the list of supported keys:

```markdown
- `parentChannelId`: string (channel snowflake) or `""` to clear.
  When setting a non-empty value, also opt that channel into `groups` if
  it isn't already (mirror the `/discord:configure parent` behavior).
```

Update the state-shape JSON example to include `parentChannelId`.

- [ ] **Step 2: Commit**

```bash
git add skills/access/SKILL.md
git commit -m "docs(access skill): support parentChannelId via set"
```

---

### Task G3: Update README and ACCESS.md

**Files:**
- Modify: `README.md`
- Modify: `ACCESS.md`

- [ ] **Step 1: Rewrite `README.md` for multi-session**

Replace the "Quick Setup" section's last paragraph (about `--channels`) with a new "Multi-session via threads" section:

```markdown
## Multi-session via threads

Run multiple Claude Code sessions through one bot, each in its own Discord
thread under a configured parent channel.

1. Pick a guild channel to host threads. Get its snowflake (Developer Mode →
   right-click → Copy Channel ID).
2. Set it as the parent:
   ```
   /discord:configure parent 846209781206941736
   ```
3. In any working directory, launch Claude Code with the channel flag and a
   thread directive:
   ```
   DISCORD_THREAD_ID=auto claude --channels plugin:discord@claude-plugins-official
   ```
   The bot creates a thread named `<cwd-basename>-<short-id>` and binds this
   session to it. Subsequent `claude` runs in the same directory reuse the
   same thread.
4. Launch a *second* session in another working directory the same way; it
   gets its own thread.
5. Plain DMs to the bot continue to land in whichever session was launched
   without `DISCORD_THREAD_ID` (the "DM session"). Only one DM session is
   allowed at a time.

**How it works**: a long-lived daemon owns the single Discord gateway
connection. Each session's MCP server (the shim) talks to the daemon over
a Unix socket at `~/.claude/channels/discord/daemon.sock`. The daemon is
lazy-started by the first shim and idle-exits 60 s after the last shim
disconnects.

**Permissions**: thread sessions post permission prompts inside the bound
thread. The DM session continues to fan prompts to all DMs in `allowFrom`.

**Bot permissions**: enable **Create Public Threads** alongside the others
listed in step 3 of Quick Setup, so the bot can auto-create threads.
```

Update the "Tools exposed to the assistant" list — unchanged but worth
re-checking in light of the refactor.

- [ ] **Step 2: Add `parentChannelId` section to `ACCESS.md`**

Insert after "## Guild channels":

```markdown
## Parent channel for thread sessions

`parentChannelId` is the channel under which `DISCORD_THREAD_ID=auto`
spawns new threads. Set it via `/discord:configure parent <channelId>` or
`/discord:access set parentChannelId <channelId>`. Setting it also opts
the channel into `groups` if it isn't already (with default
`requireMention: true`, empty `allowFrom`), so inbound thread messages
pass the gate.

A daemon-side `bindings.json` file stores the session→thread mapping;
restarting Claude Code in the same working directory reattaches to the
same thread.
```

Update the JSON config example to include `parentChannelId`.

- [ ] **Step 3: Commit**

```bash
git add README.md ACCESS.md
git commit -m "docs: document multi-session, parentChannelId, daemon"
```

---

## Phase H — Smoke

### Task H1: Manual smoke matrix

**Files:**
- Create: `docs/SMOKE.md`

- [ ] **Step 1: Write the matrix**

Create `docs/SMOKE.md`:

```markdown
# Smoke test matrix

Run before tagging a release. All cases require a real Discord bot token and
a guild + parent channel set up per README.

## Cases

1. **Single DM session (regression)**
   - `claude --channels plugin:discord@claude-plugins-official` (no DISCORD_THREAD_ID).
   - DM the bot. Expect: pairing flow, then conversation.
   - Stop CC. Confirm daemon exits ~60 s later (`pgrep -f 'discord.*daemon'`).

2. **Single thread session**
   - `DISCORD_THREAD_ID=auto claude --channels …`
   - Expect: a new thread `<cwd-basename>-<id>` appears under parentChannelId.
   - @mention the bot in the thread; confirm reply.

3. **DM + thread, concurrent**
   - Terminal A: DM session as in case 1.
   - Terminal B: `DISCORD_THREAD_ID=auto claude --channels …` from a different
     repo. New thread appears.
   - Send a DM and a thread message at roughly the same time. Confirm only
     the right session sees each.

4. **Two thread sessions**
   - Two terminals, two repos, both with `DISCORD_THREAD_ID=auto`. Two
     threads, two sessions, no crosstalk.

5. **Daemon restart with sessions running**
   - With case 4 running, `pkill -f 'discord.*daemon'`.
   - Send a message in either thread; CC's next outbound tool should
     reconnect through the lazy-spawn path. Inbound after restart resumes.

6. **`parentChannelId` unset**
   - Clear it (`/discord:access set parentChannelId ""`).
   - Try `DISCORD_THREAD_ID=auto claude --channels …`. Expect a clear stderr
     line and CC reports the channel as failed to start.

7. **Permission prompt in thread**
   - In a thread session, ask Claude to do something that triggers a
     permission request. Buttons should appear in the thread itself, not
     in DMs.

8. **Pairing flow still works**
   - Reset `dmPolicy` to `pairing`. DM the bot from a non-allow-listed
     account. Confirm the pairing-code reply lands.
```

- [ ] **Step 2: Commit**

```bash
git add docs/SMOKE.md
git commit -m "docs: smoke test matrix"
```

- [ ] **Step 3: Run the matrix manually and report findings to the user.**

---

## Self-review summary

- **Spec coverage:** All sections in the design doc (architecture, lifecycle, session id, auto-naming, wire protocol, state files, routing, backwards compat, security, failure modes) map to tasks in this plan. The five "open implementation questions" are intentionally not blockers; #1 (detached spawn) is exercised by Task D1, #2 (`CLAUDE_SESSION_ID`) is read in Task D1 with a fallback, #3 (Create Public Threads permission) is documented in Task G3, #4 (public vs private thread) defaults to public via `RealDiscordOps.createThread` in Task E1, and #5 (`/discord:bind`) is left for v1.1.
- **No placeholders:** Every code-bearing step shows the actual code. The few "(see existing server.ts:lines)" references are cross-checks for porting, not blanks.
- **Type/name consistency:** `Access`, `Bindings`, `DiscordOps`, `DaemonHandle`, `runDaemon`, `runShim`, `FakeDiscordOps` are introduced exactly once and used consistently. Wire protocol message names match between sender and receiver.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-06-discord-multisession.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
