// Keep instants as bigint and encode their decimal digits directly. A Number
// would round the large values C15b requires unchanged (RFC-0001 §8.5).

/** spec/sdk-conformance.md §3.2's `last_heartbeat_day` divisor. */
export const MS_PER_DAY = 86_400_000n

/**
 * An optionally signed run of ASCII digits, and nothing else. Whitespace is
 * trimmed first (JELTO_NOW arrives from an environment variable). `null` is
 * "not a whole number of milliseconds" — never a guessed 0.
 */
export function parseInstant(text: string): bigint | null {
  const trimmed = text.trim()
  if (!/^[+-]?[0-9]+$/.test(trimmed)) return null
  try {
    return BigInt(trimmed)
  } catch {
    return null
  }
}

/**
 * Euclidean division, which is what a UTC day index needs: BigInt `/` truncates
 * toward zero, so `-1n / 86_400_000n` is `0n` and 1969 would share a day index
 * with 1970. C15b's pre-epoch clock is exactly that case.
 */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  if (a % b !== 0n && a < 0n !== b < 0n) return q - 1n
  return q
}

/** spec/sdk-conformance.md §3.2's `last_heartbeat_day`: floor(ms / 86 400 000). */
export function dayIndex(ms: bigint): bigint {
  return floorDiv(ms, MS_PER_DAY)
}

const TWO_48 = 1n << 48n

/**
 * The value reduced into [0, 2^48) — a Euclidean modulus, so a pre-epoch
 * instant still yields a non-negative residue and `uuidV7` still produces a
 * well-formed, non-nil id (spec/wire-v1.md §3). An `id` is a dedup key, not a
 * second timestamp, and §8.5 does not let the SDK move the clock to make one
 * pretty.
 */
export function low48(ms: bigint): bigint {
  return ((ms % TWO_48) + TWO_48) % TWO_48
}

/**
 * `at - now` in milliseconds as a `number`, for sizing a REAL `setTimeout`
 * only. Saturates far beyond any timer's patience rather than wrapping; the
 * authoritative comparison is always the bigint one.
 */
export function millisUntil(now: bigint, at: bigint): number {
  const delta = at - now
  if (delta <= 0n) return 0
  if (delta > 2_147_483_647n) return 2_147_483_647
  return Number(delta)
}
