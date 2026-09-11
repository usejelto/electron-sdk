// Pin the diagnostic substrings required by C8c, C9b, C10, C16, C16b, C17,
// C20b, C22c, and W2–W4. Client-side rejections leave no mock request to assert on.
// Engine-owned diagnostics are tested against a server in engine.test.ts.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { headerNote } from './backoff.ts'
import { Debug } from './debug.ts'
import {
  gateClientVersion,
  gateEventName,
  gateInstallProps,
  gateOnboarding,
  gateTrackProps,
  withinPropCap,
} from './wire.ts'

function capture(enabled = true): { log: Debug; text(): string } {
  let text = ''
  const stream = { write: (chunk: string | Buffer): boolean => ((text += chunk.toString()), true) }
  return { log: new Debug(stream as unknown as NodeJS.WritableStream, enabled), text: () => text }
}

/** Each row: the substring a scenario greps for, and the call that owes it. */
const OWED: Array<{ scenario: string; substring: string; produce(log: Debug): void }> = [
  {
    scenario: 'W2',
    substring: '^[a-z0-9_:.-]{1,64}$',
    produce: (log) => void gateEventName('Bad Name!', log),
  },
  {
    scenario: 'W3 (a 201-character string)',
    substring: 'spec/wire-v1.md §3 caps a string at 200',
    produce: (log) => void gateTrackProps({ k: 'a'.repeat(201) }, 'x', log),
  },
  {
    scenario: 'W3 (a twenty-first key)',
    substring: 'spec/wire-v1.md §3 caps them at 20',
    produce: (log) => {
      const props: Record<string, string> = {}
      for (let i = 1; i <= 21; i += 1) props[`k${i}`] = 'a'
      gateTrackProps(props, 'y', log)
    },
  },
  {
    scenario: 'W4',
    substring: '^[a-z]+/[0-9A-Za-z.+-]{1,24}$',
    produce: (log) => void gateClientVersion('1.2.0', log),
  },
  {
    scenario: 'C20b (step)',
    substring: '^[a-z0-9_-]{1,32}$',
    produce: (log) => void gateOnboarding('Bad Step!', 'ok', undefined, log),
  },
  {
    scenario: 'C20b (reason)',
    substring: '^[a-z0-9_.-]+$',
    produce: (log) => void gateOnboarding('x', 'ok', 'Free text reason', log),
  },
  {
    scenario: 'C22c (key)',
    substring: '^[a-z0-9_]{1,32}$',
    produce: (log) => void gateInstallProps({ Email: 'x@y.z' }, log),
  },
  {
    scenario: 'C22c (value)',
    substring: '^[a-z0-9_.-]{1,24}$',
    produce: (log) => void gateInstallProps({ license: 'a'.repeat(30) }, log),
  },
  {
    scenario: 'C8c arm A',
    substring: 'exceeds the 3600 s ceiling',
    produce: (log) => {
      const note = headerNote('9999')
      if (note !== null) log.log(note)
    },
  },
  {
    scenario: 'C8c arm C',
    substring: 'is not delay-seconds and is treated as absent',
    produce: (log) => {
      const note = headerNote('soon')
      if (note !== null) log.log(note)
    },
  },
]

for (const row of OWED) {
  test(`${row.scenario}: stderr carries ${JSON.stringify(row.substring)}`, () => {
    const sink = capture()
    row.produce(sink.log)
    assert.ok(
      sink.text().includes(row.substring),
      `the path that owes ${JSON.stringify(row.substring)} wrote: ${JSON.stringify(sink.text())}`,
    )
    // Every log line stays ONE line, or a scenario grepping for a whole line
    // reads half of one.
    for (const line of sink.text().split('\n')) {
      if (line !== '') assert.ok(line.startsWith('jelto: '), line)
    }
  })
}

test('C10: with JELTO_DEBUG unset nothing whatever reaches stderr', () => {
  const sink = capture(false)
  for (const row of OWED) row.produce(sink.log)
  // And the paths this file does not otherwise reach.
  withinPropCap(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'a'])), sink.log)
  sink.log.payload(Buffer.from('{"v":1}'))
  assert.equal(sink.text(), '', 'stderr must be byte-empty without JELTO_DEBUG=1')
})

test('C17: the payload line carries the body bytes unaltered', () => {
  const sink = capture()
  const body = Buffer.from('{"v":1,"p":"prd_conform001","e":[{"t":99999999999999999999}]}', 'utf8')
  sink.log.payload(body)
  assert.ok(sink.text().includes(body.toString('utf8')))
  assert.equal(sink.text(), `jelto: POST ${body.toString('utf8')}\n`)
})

test('a caller-supplied newline cannot split a log line', () => {
  const sink = capture()
  gateEventName('bad\nname', sink.log)
  assert.equal(sink.text().split('\n').filter((line) => line !== '').length, 1)
})
