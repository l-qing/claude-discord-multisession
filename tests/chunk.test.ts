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
    // chunks collectively contain every word; whitespace at boundaries is
    // implementation detail.
    expect(out.join('').replace(/\s+/g, ' ').trim()).toBe(text)
  })

  test('hard cut when no whitespace available', () => {
    const text = 'a'.repeat(100)
    const out = chunk(text, 40, 'newline')
    expect(out.every(c => c.length <= 40)).toBe(true)
  })
})
