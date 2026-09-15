// The queue's cap-eviction rule — C6, and the reload half C4b and C8 turn on.

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EventQueue, QUEUE_MAX_BYTES, QUEUE_MAX_EVENTS } from './queue.ts'
import type { QueuedEvent } from './wire.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'jelto-queue-'))
}

function event(n: string, t = '1788134400000', props?: Record<string, string>): QueuedEvent {
  const out: QueuedEvent = { id: `id-${n}`, n, t }
  if (props !== undefined) out.props = props
  return out
}

test('acknowledging an evicted in-flight batch preserves all newer unsent events', () => {
  const dir = scratch()
  try {
    const queue = new EventQueue(dir, join(dir, 'queue.jsonl'))
    queue.append(event('sent'))
    const sent = queue.head(1)
    for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) queue.append(event(`update-${i}`))
    queue.removeIDs(new Set(sent.map((item) => item.id)))
    assert.equal(queue.length, QUEUE_MAX_EVENTS)
    assert.equal(queue.head(1)[0]!.n, 'update-0')
    queue.load()
    assert.equal(queue.length, QUEUE_MAX_EVENTS)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a failed recovery checkpoint leaves the previous queue intact', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'queue.jsonl')
    const queue = new EventQueue(dir, path)
    for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) queue.append(event(`x${i}`))
    const before = queue.exported()
    mkdirSync(`${path}.tmp`)
    const update = { ...event('app_updated'), id: 'transition' }
    assert.equal(queue.recover(update), false)
    assert.deepEqual(queue.exported(), before)
    queue.load()
    assert.deepEqual(queue.exported(), before)
    rmSync(`${path}.tmp`, { recursive: true })
    assert.equal(queue.recover(update), true)
    assert.equal(queue.head(1)[0]!.n, 'x1')
    assert.equal(queue.head(QUEUE_MAX_EVENTS).at(-1)!.id, update.id)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a reset queue checkpoint retains the receipt until the old state intent is retired', () => {
  const dir = scratch()
  try {
    const queue = new EventQueue(dir, join(dir, 'queue.jsonl'))
    const update = event('app_updated')
    assert.equal(queue.recover(update), true)
    assert.equal(queue.discardIdentityEvents(), true)
    // Reset can fail its subsequent state commit or crash before retiring the intent.
    queue.load()
    assert.equal(queue.recover(update), true)
    assert.equal(queue.contains('app_updated'), false)
    assert.equal(queue.byteCount, 0)
    queue.delete()
    assert.equal(queue.recover(update), true)
    assert.equal(queue.contains('app_updated'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy queue recovery remembers handoff before a failed checkpoint and later cap eviction', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'queue.jsonl')
    const legacy = new EventQueue(dir, path)
    const update = event('app_updated')
    legacy.append(update)
    for (let i = 0; i < QUEUE_MAX_EVENTS - 1; i += 1) legacy.append(event(`old-${i}`))
    const queue = new EventQueue(dir, path)
    queue.load(update.id)
    mkdirSync(`${path}.tmp`)
    assert.equal(queue.recover(update), false)
    queue.append(event('new-0'))
    assert.equal(queue.contains('app_updated'), false)
    rmSync(`${path}.tmp`, { recursive: true })
    queue.append(event('new-1'))
    queue.load()
    assert.equal(queue.recover(update), true)
    assert.equal(queue.contains('app_updated'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('C6: 1 500 tracks leave 1 000 events, and the OLDEST were dropped', () => {
  const dir = scratch()
  try {
    const queue = new EventQueue(dir, join(dir, 'queue.jsonl'))
    let dropped = 0
    for (let i = 0; i < 1500; i += 1) dropped += queue.append(event(`x${i}`))
    assert.equal(queue.length, QUEUE_MAX_EVENTS)
    assert.equal(dropped, 500)
    const held = queue.exported().map((entry) => entry.n)
    // §4's 1-based "events 1-500 absent, 501-1500 present" is x0-x499 and
    // x500-x1499 here, and it is a fact about IDENTITY, not about a count.
    assert.equal(held[0], 'x500')
    assert.equal(held[held.length - 1], 'x1499')
    assert.ok(!held.includes('x0'))
    assert.ok(!held.includes('x499'))
    assert.ok(queue.byteCount <= QUEUE_MAX_BYTES)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C6: the BYTE half binds on its own once events are over ~1 049 B', () => {
  const dir = scratch()
  try {
    const queue = new EventQueue(dir, join(dir, 'queue.jsonl'))
    const fat = { k1: 'a'.repeat(200), k2: 'b'.repeat(200), k3: 'c'.repeat(200), k4: 'd'.repeat(200), k5: 'e'.repeat(200) }
    for (let i = 0; i < 1200; i += 1) queue.append(event(`x${i}`, '1788134400000', fat))
    // The two caps cross at 1 048 576 / 1 000 ~ 1 049 B per event; above that
    // the byte count is the only one doing any work.
    assert.ok(queue.length < QUEUE_MAX_EVENTS, String(queue.length))
    assert.ok(queue.byteCount <= QUEUE_MAX_BYTES, String(queue.byteCount))
    assert.equal(queue.exported()[queue.length - 1]?.n, 'x1199')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('`bytes` is what the SDK counts, and it tracks append/remove exactly', () => {
  const dir = scratch()
  try {
    const queue = new EventQueue(dir, join(dir, 'queue.jsonl'))
    assert.equal(queue.byteCount, 0)
    queue.append(event('x'))
    const one = queue.byteCount
    assert.equal(one, Buffer.byteLength(JSON.stringify(event('x')), 'utf8') + 1)
    queue.append(event('y'))
    queue.remove(1)
    assert.equal(queue.byteCount, Buffer.byteLength(JSON.stringify(event('y')), 'utf8') + 1)
    queue.remove(5) // more than it holds
    assert.equal(queue.length, 0)
    assert.equal(queue.byteCount, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a queue survives a relaunch with the SAME ids and the SAME `t` digits', () => {
  const dir = scratch()
  try {
    const first = new EventQueue(dir, join(dir, 'queue.jsonl'))
    first.append(event('install', '99999999999999999999'))
    first.append(event('x', '-14256000000'))

    const second = new EventQueue(dir, join(dir, 'queue.jsonl'))
    second.load()
    assert.deepEqual(second.exported(), [
      { id: 'id-install', n: 'install', t: '99999999999999999999' },
      { id: 'id-x', n: 'x', t: '-14256000000' },
    ])
    assert.equal(second.byteCount, first.byteCount)
    assert.equal(second.contains('install'), true)
    assert.equal(second.contains('heartbeat'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a half-written line costs that event, not the file', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'queue.jsonl')
    const first = new EventQueue(dir, path)
    first.append(event('a'))
    first.append(event('b'))
    // Simulate a process killed mid-append.
    appendFileSync(path, '{"id":"id-c","n":"c"')
    const second = new EventQueue(dir, path)
    second.load()
    assert.deepEqual(
      second.exported().map((entry) => entry.n),
      ['a', 'b'],
    )
    second.append(event('d'))
    second.load()
    assert.deepEqual(second.exported().map((entry) => entry.n), ['a', 'b', 'd'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C18: delete removes the file and everything it held', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'queue.jsonl')
    const queue = new EventQueue(dir, path)
    queue.append(event('x'))
    assert.ok(existsSync(path))
    queue.delete()
    assert.equal(queue.length, 0)
    assert.equal(queue.byteCount, 0)
    assert.ok(!existsSync(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C5: loading an absent queue creates neither the file nor the directory', () => {
  const dir = join(tmpdir(), `jelto-never-${process.pid}-${Date.now()}`)
  const queue = new EventQueue(dir, join(dir, 'queue.jsonl'))
  queue.load()
  assert.equal(queue.length, 0)
  assert.ok(!existsSync(dir))
})

test('head does not remove: a retry resends the same batch (wire §6)', () => {
  const dir = scratch()
  try {
    const queue = new EventQueue(dir, join(dir, 'queue.jsonl'))
    for (let i = 0; i < 5; i += 1) queue.append(event(`x${i}`))
    const first = queue.head(3)
    const second = queue.head(3)
    assert.deepEqual(
      first.map((e) => e.id),
      second.map((e) => e.id),
    )
    assert.equal(queue.length, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
