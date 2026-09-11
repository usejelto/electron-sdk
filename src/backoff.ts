// Backoff and Retry-After are independent floors; use the later deadline and
// advance backoff even when the header wins. Invalid headers are absent, and
// header delays cap at 3,600 seconds (C8–C8c). Only the duration multiplier uses
// floating point; instants remain exact integers.

export const BACKOFF_FIRST_STEP_MS = 1_000
export const BACKOFF_CEILING_MS = 3_600_000
export const JITTER_LOW = 0.8
export const JITTER_HIGH = 1.2

/**
 * RFC 9110 §10.2.3's `delay-seconds` and nothing else: spec/wire-v1.md §9 says
 * "the HTTP-date form is never sent", and anything unparseable is ABSENT.
 * Milliseconds, UNCLAMPED — the clamp lives in `nextBackoff` and in
 * `headerNote`, because a function that clamped silently could not tell its
 * caller that §9's ceiling line is owed.
 */
export function retryAfterMS(header: string | null): number | null {
  if (header === null) return null
  const trimmed = trimOWS(header)
  if (trimmed === '') return null
  if (!/^[0-9]+$/.test(trimmed)) return null
  const millis = BigInt(trimmed) * 1000n
  if (millis > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(millis)
}

/**
 * §9's two stderr lines, asserted verbatim by C8c arms A and C. `null` when the
 * header is absent, empty, or a plain `delay-seconds` at or below the ceiling.
 * Quotes the TRIMMED ORIGINAL TEXT rather than a parsed number, so a 40-digit
 * value renders as what was received.
 */
export function headerNote(header: string | null): string | null {
  if (header === null) return null
  const trimmed = trimOWS(header)
  if (trimmed === '') return null
  const millis = retryAfterMS(header)
  if (millis === null) {
    return `Retry-After: "${trimmed}" is not delay-seconds and is treated as absent (spec/wire-v1.md §9)`
  }
  if (millis <= BACKOFF_CEILING_MS) return null
  return `Retry-After: "${trimmed}" exceeds the 3600 s ceiling and is clamped to 3600 s (spec/wire-v1.md §9)`
}

export interface BackoffResult {
  waitMS: number
  /** Which floor governed. Not observable to the server; for the debug line. */
  source: string
  /** The absolute instant of the next attempt, on the SDK clock. */
  deadline: bigint
  /** What a NEW PROCESS must resume at (§8.3 item 8, "persisted across launches"). */
  nextStepMS: number
  /** The step that governed THIS wait, for the debug line. */
  governingStepMS: number
}

/**
 * `answeredAt` is when the ANSWER arrived, never when the request was sent:
 * RFC 9110 §10.2.3 makes `Retry-After` relative to the response, and measuring
 * from the attempt fires the retry one round trip INSIDE the interval the
 * server just named (C8b's `429:20` arm caught refhost doing it at 19 997 ms).
 *
 * The `+ 1` is not slop, it is the rounding direction the rule forces: `now` is
 * floor(wall clock in ms), so the answer really arrived in [now, now+1), and §9
 * says a client MUST NOT send before the interval elapses.
 */
export function nextBackoff(
  currentStepMS: number,
  header: string | null,
  answeredAt: bigint,
  jitter: number,
): BackoffResult {
  const step = currentStepMS <= 0 ? BACKOFF_FIRST_STEP_MS : Math.min(currentStepMS, BACKOFF_CEILING_MS)
  const factor = clampJitter(jitter)
  const backoffWait = Math.max(1, Math.min(Math.round(step * factor), BACKOFF_CEILING_MS))
  const raw = retryAfterMS(header)
  const headerWait = raw === null ? null : Math.min(raw, BACKOFF_CEILING_MS)
  const waitMS = Math.max(backoffWait, headerWait ?? 0)
  // A tie is credited to the header, which named it — deterministic, not incidental.
  const source = (headerWait ?? -1) >= backoffWait ? 'retry-after' : 'backoff'
  return {
    waitMS,
    source,
    deadline: answeredAt + BigInt(waitMS) + 1n,
    nextStepMS: Math.min(step * 2, BACKOFF_CEILING_MS),
    governingStepMS: step,
  }
}

/** NaN is special-cased before it reaches min/max, which propagate it. */
function clampJitter(jitter: number): number {
  if (Number.isNaN(jitter)) return 1
  return Math.min(Math.max(jitter, JITTER_LOW), JITTER_HIGH)
}

/** HTTP OWS: ASCII space and horizontal tab, both ends. */
function trimOWS(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && (value[start] === ' ' || value[start] === '\t')) start += 1
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end -= 1
  return value.slice(start, end)
}
