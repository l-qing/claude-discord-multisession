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
