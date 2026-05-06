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
