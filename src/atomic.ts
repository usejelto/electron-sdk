import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Replace a checkpoint without exposing a partially written destination. */
export function atomicWrite(path: string, data: string, durable = true): boolean {
  const temporary = `${path}.tmp`
  let fd: number | undefined
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    fd = openSync(temporary, 'w', 0o600)
    writeFileSync(fd, data)
    if (durable) fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    return true
  } catch {
    if (fd !== undefined) try { closeSync(fd) } catch { /* fail-soft */ }
    try { rmSync(temporary, { force: true }) } catch { /* fail-soft */ }
    return false
  }
}
