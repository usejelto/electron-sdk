import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Creates the state directory owner-only (`0700`) and re-asserts that mode when
 * it already exists (spec/sdk-conformance.md §5): `mkdirSync`'s `mode` applies
 * only to directories it creates, so a looser directory the SDK was merely
 * handed would otherwise keep exposing the install id and the queue to other
 * local accounts. The re-assertion is best effort — a filesystem with no mode
 * to set must not cost the checkpoint — and Windows has no POSIX mode; there
 * the per-user `LocalApplicationData` ACL is the bound (§5).
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* fail-soft */
  }
}

/** Replace a checkpoint without exposing a partially written destination. */
export function atomicWrite(path: string, data: string, durable = true): boolean {
  const temporary = `${path}.tmp`
  let fd: number | undefined
  try {
    ensurePrivateDir(dirname(path))
    fd = openSync(temporary, 'w', 0o600)
    writeFileSync(fd, data)
    if (durable) fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    return true
  } catch {
    if (fd !== undefined)
      try {
        closeSync(fd)
      } catch {
        /* fail-soft */
      }
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* fail-soft */
    }
    return false
  }
}
