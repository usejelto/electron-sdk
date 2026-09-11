import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { encodeReply, writeLine } from './reply.ts'

test('one reply is exactly one line', () => {
  const line = encodeReply({ cmd: 'track', ok: true })
  assert.equal(line, '{"cmd":"track","ok":true}\n')
  assert.equal(line.split('\n').length, 2)
})

test('a newline inside a value cannot become a second line', () => {
  const line = encodeReply({ cmd: 'track', ok: false, error: 'two\nlines' })
  assert.equal(line.indexOf('\n'), line.length - 1)
  assert.deepEqual(JSON.parse(line), { cmd: 'track', ok: false, error: 'two\nlines' })
})

test('absent keys are absent', () => {
  const decoded = JSON.parse(encodeReply({ cmd: 'reset', ok: true })) as Record<string, unknown>
  assert.deepEqual(Object.keys(decoded), ['cmd', 'ok'])
})

test('§3.1 keys survive a round trip', () => {
  assert.deepEqual(JSON.parse(encodeReply({ cmd: 'init', ok: true, us: 41 })), {
    cmd: 'init',
    ok: true,
    us: 41,
  })
  assert.deepEqual(JSON.parse(encodeReply({ cmd: 'installid', ok: true, value: '9f2c' })), {
    cmd: 'installid',
    ok: true,
    value: '9f2c',
  })
  assert.deepEqual(
    JSON.parse(encodeReply({ cmd: 'track', ok: false, error: 'track <name> [json-props]' })),
    { cmd: 'track', ok: false, error: 'track <name> [json-props]' },
  )
})

test("an installid that printed nothing still prints a `value` key", () => {
  // C18 asserts `host_reply, key: installid, empty: true`, which the runner
  // reads as `reply.Value == ""`; an empty string and an absent key decode the
  // same, and the explicit key says the command ran.
  assert.equal(encodeReply({ cmd: 'installid', ok: true, value: '' }), '{"cmd":"installid","ok":true,"value":""}\n')
})

test("§3.2's instants stay decimal strings through the reply", () => {
  // The export's instants are strings precisely so nothing rounds them; the
  // host must not turn one into a JSON number on the way out. C15b's clock is
  // past int64 and RFC-0001 §8.5 forbids correcting it.
  const state = {
    install_id: '2a0e5f9c-0000-4000-8000-000000000000',
    last_heartbeat_day: '20696',
    install_claimed: false,
    install_due_at: '1788134400000',
    queue: { bytes: 62431, events: [{ id: 'e1', n: 'x500', t: '99999999999999999999' }] },
  }
  const line = encodeReply({ cmd: 'dumpstate', ok: true, state })
  assert.match(line, /"install_due_at":"1788134400000"/)
  assert.match(line, /"t":"99999999999999999999"/)
})

test('writeLine resolves only after the stream has taken the bytes', async () => {
  const chunks: string[] = []
  let release: (() => void) | undefined
  const slow = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      chunks.push(chunk.toString())
      // Hold the write open, as a pipe with a busy reader would.
      release = callback
    },
  })

  let resolved = false
  const pending = writeLine(slow, 'first\n').then(() => {
    resolved = true
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(resolved, false, 'resolved before the stream had flushed')
  assert.deepEqual(chunks, ['first\n'])
  release?.()
  await pending
  assert.equal(resolved, true)
})

test('a write to a broken pipe resolves rather than throwing', async () => {
  const broken = new Writable({
    write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
      callback(new Error('EPIPE'))
    },
  })
  broken.on('error', () => {})
  await writeLine(broken, 'gone\n')
})
