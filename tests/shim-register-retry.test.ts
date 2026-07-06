import { test, expect, describe } from 'bun:test'
import {
  registerWithSelfHeal,
  isRetryableRegisterCode,
  isTransientRegisterCode,
  type RegisterSelfHealOpts,
} from '../src/shim'

const ACK = { type: 'register_ack' as const, session_id: 's', thread_id: 't' }
const err = (code: string) => ({ type: 'register_err' as const, code })

// Controllable clock: sleep advances virtual time and records the requested
// delay, so tests assert the backoff schedule + budget behavior without real timers.
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    advance: (ms: number) => { t += ms },
    sleeps,
  }
}

describe('isRetryableRegisterCode (session-taken bucket)', () => {
  test('session-taken codes are retryable', () => {
    expect(isRetryableRegisterCode('dm_session_taken')).toBe(true)
    expect(isRetryableRegisterCode('thread_session_taken')).toBe(true)
  })
  test('transient / terminal / undefined are not in the session-taken bucket', () => {
    expect(isRetryableRegisterCode('discord_unavailable')).toBe(false)
    expect(isRetryableRegisterCode('parent_channel_unset')).toBe(false)
    expect(isRetryableRegisterCode(undefined)).toBe(false)
  })
})

describe('isTransientRegisterCode (transient bucket)', () => {
  test('discord_unavailable is transient', () => {
    expect(isTransientRegisterCode('discord_unavailable')).toBe(true)
  })
  test('session-taken / terminal / undefined are not transient', () => {
    expect(isTransientRegisterCode('dm_session_taken')).toBe(false)
    expect(isTransientRegisterCode('thread_not_allowed')).toBe(false)
    expect(isTransientRegisterCode(undefined)).toBe(false)
  })
})

describe('registerWithSelfHeal', () => {
  const opts = (
    clock: ReturnType<typeof fakeClock>,
    o: Partial<RegisterSelfHealOpts> = {},
  ): RegisterSelfHealOpts => ({
    overallDeadlineMs: 600_000,
    sessionTaken: { maxAttempts: 10, delayMs: 200 },
    transient: { backoffMs: [10, 20, 40, 80, 160] },
    sendTimeoutMs: 60_000,
    now: clock.now,
    sleep: clock.sleep,
    ...o,
  })

  test('succeeds on first attempt without sleeping', async () => {
    const c = fakeClock()
    let n = 0
    const ack = await registerWithSelfHeal(async () => { n++; return ACK }, opts(c))
    expect(ack.type).toBe('register_ack')
    expect(n).toBe(1)
    expect(c.sleeps).toEqual([])
  })

  test('session-taken: fixed 200ms delay then ack (historical fast path preserved)', async () => {
    const c = fakeClock()
    let n = 0
    const send = async () => (++n < 3 ? err('thread_session_taken') : ACK)
    const ack = await registerWithSelfHeal(send, opts(c))
    expect(ack.type).toBe('register_ack')
    expect(n).toBe(3)
    expect(c.sleeps).toEqual([200, 200])
  })

  test('session-taken: exhausts maxAttempts and gives up (fast-fail cap preserved)', async () => {
    const c = fakeClock()
    let n = 0
    const send = async () => { n++; return err('dm_session_taken') }
    const ack = await registerWithSelfHeal(send, opts(c, { sessionTaken: { maxAttempts: 3, delayMs: 200 } }))
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('dm_session_taken')
    expect(n).toBe(4) // initial attempt + 3 retries
    expect(c.sleeps).toEqual([200, 200, 200])
  })

  test('transient discord_unavailable: exponential backoff then ack (the ccd self-heal)', async () => {
    const c = fakeClock()
    let n = 0
    const send = async () => (++n < 4 ? err('discord_unavailable') : ACK)
    const ack = await registerWithSelfHeal(send, opts(c))
    expect(ack.type).toBe('register_ack')
    expect(n).toBe(4)
    expect(c.sleeps).toEqual([10, 20, 40]) // exponential schedule, not the 200ms session-taken delay
  })

  test('transient: exhausts the backoff schedule and gives up', async () => {
    const c = fakeClock()
    let n = 0
    const send = async () => { n++; return err('discord_unavailable') }
    const ack = await registerWithSelfHeal(send, opts(c, { transient: { backoffMs: [10, 20] } }))
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('discord_unavailable')
    expect(n).toBe(3) // initial + 2 backoff retries
    expect(c.sleeps).toEqual([10, 20])
  })

  test('terminal config/data error: returned after one attempt, no retry', async () => {
    const c = fakeClock()
    let n = 0
    const send = async () => { n++; return err('parent_channel_unset') }
    const ack = await registerWithSelfHeal(send, opts(c))
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('parent_channel_unset')
    expect(n).toBe(1)
    expect(c.sleeps).toEqual([])
  })

  test('overall budget caps total wall-clock even if a bucket is not exhausted', async () => {
    const c = fakeClock()
    let n = 0
    const send = async () => { n++; return err('discord_unavailable') }
    const ack = await registerWithSelfHeal(send, opts(c, {
      overallDeadlineMs: 50,
      transient: { backoffMs: [10, 20, 40, 80, 160] },
    }))
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('discord_unavailable')
    // Every sleep is clipped so the total never overruns the budget.
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(50)
  })

  test('send timeout is clipped to the remaining budget', async () => {
    const c = fakeClock()
    const seen: number[] = []
    let n = 0
    const send = async (timeoutMs: number) => { seen.push(timeoutMs); return ++n < 2 ? err('discord_unavailable') : ACK }
    await registerWithSelfHeal(send, opts(c, {
      overallDeadlineMs: 1000, sendTimeoutMs: 60_000, transient: { backoffMs: [100] },
    }))
    expect(seen[0]).toBe(1000) // clipped to remaining budget, not 60000
    expect(seen[1]).toBe(900)  // after a 100ms backoff, remaining = 900
  })

  test('a send that consumes the whole remaining budget ends the loop', async () => {
    const c = fakeClock()
    let calls = 0
    // Simulate a send that burns its full granted timeout (a slow / timing-out
    // attempt) by advancing the clock, then returns a transient error. The loop
    // must not start another attempt once the budget is gone.
    const send = async (timeoutMs: number) => { calls++; c.advance(timeoutMs); return err('discord_unavailable') }
    const ack = await registerWithSelfHeal(send, opts(c, {
      overallDeadlineMs: 100, sendTimeoutMs: 1000, transient: { backoffMs: [5, 5, 5, 5] },
    }))
    expect(ack.code).toBe('discord_unavailable')
    expect(calls).toBe(1)      // first send clipped to 100ms consumes the whole budget → stop
    expect(c.sleeps).toEqual([]) // no backoff sleep — budget gone before it could sleep
  })

  test('send timeout / socket error is terminal in Scope A (daemon_unresponsive, no in-band retry)', async () => {
    const c = fakeClock()
    let n = 0
    const send = async () => { n++; throw new Error('daemon timeout: register') }
    const ack = await registerWithSelfHeal(send, opts(c))
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('daemon_unresponsive')
    expect(n).toBe(1)
  })

  test('session-taken and transient buckets have independent counters', async () => {
    const c = fakeClock()
    const seq = ['thread_session_taken', 'discord_unavailable', 'thread_session_taken', 'discord_unavailable']
    let calls = 0
    const send = async () => { calls++; return calls <= seq.length ? err(seq[calls - 1]!) : ACK }
    const ack = await registerWithSelfHeal(send, opts(c, {
      sessionTaken: { maxAttempts: 2, delayMs: 200 },
      transient: { backoffMs: [10, 20] },
    }))
    expect(ack.type).toBe('register_ack')
    expect(calls).toBe(5) // 2 session-taken + 2 transient retries, then success
    expect(c.sleeps).toEqual([200, 10, 200, 20]) // each bucket keeps its own schedule, no cross-reset
  })
})
