// Use Node's CSPRNG for event and install UUIDs without native addons.

import { randomBytes, randomUUID } from 'node:crypto'
import { low48 } from './instant.ts'

/**
 * The one UUID spec/wire-v1.md §3 forbids in `id` and §5.2 forbids in `iid`.
 * Named so the code can be seen never to send it (W1).
 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** RFC-0001 §8.2 item 2's install_id: "create a UUIDv4 if absent" (C2). */
export function uuidV4(): string {
  return randomUUID()
}

/**
 * spec/wire-v1.md §3's per-event `id` ("UUID (v7 preferred)"). The 48-bit
 * timestamp is the SDK clock's milliseconds taken modulo 2^48, so C15b's
 * pre-epoch and past-int64 clocks still produce a well-formed, non-nil v7.
 */
export function uuidV7(now: bigint): string {
  const bytes = randomBytes(16)
  const stamp = low48(now)
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((stamp >> BigInt((5 - i) * 8)) & 0xffn)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  const out = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  // Unreachable: the version and variant nibbles are non-zero. Kept because §3
  // makes "never the nil UUID" the rule, and a rule with no enforcement is a
  // comment.
  return out === NIL_UUID ? uuidV4() : out
}
