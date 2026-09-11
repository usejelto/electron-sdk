// spec/wire-v1.md §9 composed with RFC-0001 §8.3 item 8 — C8, C8b, C8c.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BACKOFF_CEILING_MS,
  headerNote,
  nextBackoff,
  retryAfterMS,
} from './backoff.ts'

test('retryAfterMS reads delay-seconds and NOTHING else', () => {
  assert.equal(retryAfterMS('2'), 2_000)
  assert.equal(retryAfterMS(' 20 '), 20_000) // HTTP OWS is trimmed
  assert.equal(retryAfterMS('007'), 7_000)
  assert.equal(retryAfterMS('9999'), 9_999_000)
  // C8c arm B: `429:` omits the header entirely.
  assert.equal(retryAfterMS(null), null)
  assert.equal(retryAfterMS(''), null)
  assert.equal(retryAfterMS('   '), null)
  // C8c arm C: unparseable is ABSENT, never zero.
  assert.equal(retryAfterMS('soon'), null)
  assert.equal(retryAfterMS('Wed, 21 Oct 2026 07:28:00 GMT'), null)
  assert.equal(retryAfterMS('-1'), null)
  assert.equal(retryAfterMS('2.5'), null)
})

test('C8c arm A: 9999 is honoured but clamped to 3600 s, and the step advances anyway', () => {
  const result = nextBackoff(0, '9999', 1_000_000n, 1.0)
  assert.equal(result.waitMS, BACKOFF_CEILING_MS)
  assert.equal(result.source, 'retry-after')
  assert.equal(result.deadline, 1_000_000n + BigInt(BACKOFF_CEILING_MS) + 1n)
  assert.equal(result.nextStepMS, 2_000) // "the backoff advanced regardless"
  assert.equal(
    headerNote('9999'),
    'Retry-After: "9999" exceeds the 3600 s ceiling and is clamped to 3600 s (spec/wire-v1.md §9)',
  )
})

test('C8c arm B: no header at all falls back to the backoff alone', () => {
  const result = nextBackoff(0, null, 0n, 1.0)
  assert.equal(result.waitMS, 1_000)
  assert.equal(result.source, 'backoff')
  assert.equal(headerNote(null), null)
  assert.equal(headerNote(''), null)
})

test('C8c arm C: an unparseable header is absent, never zero', () => {
  const result = nextBackoff(0, 'soon', 0n, 1.0)
  assert.equal(result.waitMS, 1_000) // not 0
  assert.equal(result.source, 'backoff')
  assert.equal(
    headerNote('soon'),
    'Retry-After: "soon" is not delay-seconds and is treated as absent (spec/wire-v1.md §9)',
  )
})

test('C8c arm D: Retry-After 1 at the tenth refusal neither shortens nor resets', () => {
  // Ten consecutive refusals under `429:` double the step 1000 -> 512000, and
  // the tenth answer carries `503: Retry-After: 1`.
  let step = 0
  for (let i = 0; i < 9; i += 1) step = nextBackoff(step, null, 0n, 1.0).nextStepMS
  assert.equal(step, 512_000)
  const tenth = nextBackoff(step, '1', 0n, 1.0)
  assert.equal(tenth.waitMS, 512_000) // the header did not shorten it
  assert.equal(tenth.source, 'backoff')
  assert.equal(tenth.nextStepMS, 1_024_000) // C8c asserts backoff_step_ms = 1024000
})

test('C8: the schedule doubles to the 3600 s ceiling and stops there', () => {
  const steps: number[] = []
  let step = 0
  for (let i = 0; i < 15; i += 1) {
    const result = nextBackoff(step, null, 0n, 1.0)
    steps.push(result.waitMS)
    step = result.nextStepMS
  }
  assert.deepEqual(steps.slice(0, 5), [1_000, 2_000, 4_000, 8_000, 16_000])
  assert.equal(steps[steps.length - 1], BACKOFF_CEILING_MS)
  assert.equal(step, BACKOFF_CEILING_MS)
})

test('C8/C8b: the next attempt is at the LATER of the two floors', () => {
  // C8's `503` arm: Retry-After 2 against a ~1 s step -> ~2, then 2, then 4.
  assert.equal(nextBackoff(1_000, '2', 0n, 1.0).waitMS, 2_000)
  assert.equal(nextBackoff(2_000, '2', 0n, 1.0).waitMS, 2_000)
  assert.equal(nextBackoff(4_000, '2', 0n, 1.0).waitMS, 4_000)
  // C8b arm C: at Retry-After 3 the crossover is the third retry -> 3, 3, 4, 8.
  const waits = [1_000, 2_000, 4_000, 8_000].map((step) => nextBackoff(step, '3', 0n, 1.0).waitMS)
  assert.deepEqual(waits, [3_000, 3_000, 4_000, 8_000])
})

test('the deadline runs from the ANSWER and rounds UP by one millisecond', () => {
  // spec/wire-v1.md §9 is a MUST NOT-send-before, and `now` is floor(ms).
  assert.equal(nextBackoff(0, '20', 1_000n, 1.0).deadline, 1_000n + 20_000n + 1n)
})

test('jitter stays inside ±20 % whatever the caller hands over', () => {
  assert.equal(nextBackoff(1_000, null, 0n, 0.8).waitMS, 800)
  assert.equal(nextBackoff(1_000, null, 0n, 1.2).waitMS, 1_200)
  assert.equal(nextBackoff(1_000, null, 0n, 99).waitMS, 1_200)
  assert.equal(nextBackoff(1_000, null, 0n, -99).waitMS, 800)
  // NaN would trap `min`/`max` into propagating it; RFC-0001 §8.3 item 10
  // forbids throwing into the host.
  assert.equal(nextBackoff(1_000, null, 0n, Number.NaN).waitMS, 1_000)
})
