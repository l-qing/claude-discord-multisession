import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from 'fs'
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
    const corrupt = readdirSync(dir).filter(f => f.startsWith('bindings.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
  })
})
