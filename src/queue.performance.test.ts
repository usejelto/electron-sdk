import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EventQueue, QUEUE_MAX_BYTES, QUEUE_MAX_EVENTS } from './queue.ts'
import type { QueuedEvent } from './wire.ts'

function event(index: number, props?: Record<string, string>): QueuedEvent {
  return { id: `id-${String(index).padStart(6, '0')}`, n: 'observed', t: '1788134400000', ...(props && { props }) }
}

for (const [cap, props] of [
  ['count', undefined],
  ['bytes', Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`k${index}`, 'x'.repeat(200)]))],
] as const) {
  test(`${cap}-capped appends amortize checkpoint bytes and retain a bounded, replayable file`, (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'jelto-queue-cost-'))
    const path = join(dir, 'queue.jsonl')
    const originalAppend = fs.appendFileSync
    const originalWrite = fs.writeFileSync
    let appends = 0, checkpoints = 0, writtenBytes = 0
    t.mock.method(fs, 'appendFileSync', (...args: Parameters<typeof fs.appendFileSync>) => {
      appends++
      writtenBytes += Buffer.byteLength(args[1])
      return originalAppend(...args)
    })
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      // appendFileSync delegates to writeFileSync with the path in Node 24;
      // atomicWrite uses its separately opened descriptor. Count each once.
      if (typeof args[0] === 'number') {
        checkpoints++
        writtenBytes += typeof args[1] === 'string' ? Buffer.byteLength(args[1]) : args[1].byteLength
      }
      return originalWrite(...args)
    })
    syncBuiltinESMExports()
    try {
      const queue = new EventQueue(dir, path)
      for (let i = 0; i < 1100; i++) queue.append(event(i, props))
      appends = 0; checkpoints = 0; writtenBytes = 0
      let inputBytes = 0
      for (let i = 1100; i < 3300; i++) {
        const next = event(i, props)
        inputBytes += Buffer.byteLength(JSON.stringify(next)) + 1
        queue.append(next)
        assert.ok(fs.statSync(path).size <= queue.byteCount + Math.max(queue.byteCount, 64 << 10))
      }
      // Both workloads compact eventually, without a checkpoint for every
      // eviction. Count actual filesystem writes, not an internal counter.
      assert.ok(checkpoints > 0 && checkpoints < 10, String(checkpoints))
      assert.equal(appends + checkpoints, 2200)
      assert.ok(writtenBytes <= inputBytes * 4, `${writtenBytes} bytes for ${inputBytes} input bytes`)
      assert.ok(queue.byteCount <= QUEUE_MAX_BYTES)
      if (cap === 'count') assert.equal(queue.length, QUEUE_MAX_EVENTS)
      else assert.ok(queue.length < QUEUE_MAX_EVENTS)
      const expected = queue.head(QUEUE_MAX_EVENTS)
      queue.load()
      assert.deepEqual(queue.head(QUEUE_MAX_EVENTS), expected)
      assert.equal(fs.statSync(path).size, queue.byteCount)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('failed compaction stops file growth and checkpoints retained events when storage recovers', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'jelto-queue-full-'))
  const path = join(dir, 'queue.jsonl')
  try {
    const queue = new EventQueue(dir, path)
    for (let i = 0; i < 1000; i++) queue.append(event(i))
    fs.mkdirSync(`${path}.tmp`)
    for (let i = 1000; i < 3000; i++) queue.append(event(i))
    const stoppedSize = fs.statSync(path).size
    assert.ok(stoppedSize <= queue.byteCount + Math.max(queue.byteCount, 64 << 10))
    for (let i = 3000; i < 3100; i++) queue.append(event(i))
    assert.equal(fs.statSync(path).size, stoppedSize)
    fs.rmSync(`${path}.tmp`, { recursive: true })
    queue.append(event(3100))
    const expected = queue.head(QUEUE_MAX_EVENTS)
    assert.equal(fs.statSync(path).size, queue.byteCount)
    queue.load()
    assert.deepEqual(queue.head(QUEUE_MAX_EVENTS), expected)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a partial failed append is repaired before a later successful append', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'jelto-queue-torn-'))
  const path = join(dir, 'queue.jsonl')
  const originalAppend = fs.appendFileSync
  try {
    const queue = new EventQueue(dir, path)
    queue.append(event(0))
    t.mock.method(fs, 'appendFileSync', (...args: Parameters<typeof fs.appendFileSync>) => {
      originalAppend(args[0], '{"id":"torn"')
      throw new Error('injected partial write')
    })
    syncBuiltinESMExports()
    queue.append(event(1))
    t.mock.restoreAll()
    syncBuiltinESMExports()
    queue.append(event(2))
    queue.load()
    assert.deepEqual(queue.head(3), [event(0), event(1), event(2)])
    assert.equal(fs.statSync(path).size, queue.byteCount)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
