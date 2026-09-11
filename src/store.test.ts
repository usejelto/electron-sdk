import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from './store.ts'

test('legacy or corrupt update intents are ignored without losing valid install state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-store-'))
  try {
    for (const pending of [undefined, null, 42, 'broken', {}, { id: 'x', n: 'app_updated', t: '0', props: {} }]) {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ install_id: 'existing', install_claimed: true, last_app_version: 'B', pending_update: pending }))
      const state = new Store(dir).load()
      assert.equal(state.install_id, 'existing')
      assert.equal(state.install_claimed, true)
      assert.equal(state.last_app_version, 'B')
      assert.equal(state.pending_update, undefined)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('wipe deletes only what this SDK put in the state directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-store-wipe-'))
  try {
    const store = new Store(dir)
    store.update((state) => { state.install_id = 'x' })
    writeFileSync(join(dir, 'queue.jsonl'), '{"id":"a","n":"x","t":"0"}\n')
    writeFileSync(join(dir, 'state.json.tmp'), 'torn')
    writeFileSync(join(dir, 'queue.jsonl.tmp'), 'torn')
    writeFileSync(join(dir, 'UNRELATED.txt'), 'a customer file, not ours')
    mkdirSync(join(dir, 'some-subdir'))
    writeFileSync(join(dir, 'some-subdir', 'nested.txt'), 'also not ours')

    store.wipe()

    assert.equal(existsSync(join(dir, 'state.json')), false)
    assert.equal(existsSync(join(dir, 'state.json.tmp')), false)
    assert.equal(existsSync(join(dir, 'queue.jsonl')), false)
    assert.equal(existsSync(join(dir, 'queue.jsonl.tmp')), false)
    // Survivors: an unrelated file and a whole subdirectory, untouched.
    assert.deepEqual(readdirSync(dir).sort(), ['UNRELATED.txt', 'some-subdir'])
    assert.equal(existsSync(join(dir, 'some-subdir', 'nested.txt')), true)
    // The directory itself is left in place — C18/C22d's readdir assertion
    // (engine.test.ts) depends on it still existing.
    assert.equal(existsSync(dir), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('wipe on a directory holding only this SDK\'s own files leaves it empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-store-wipe-empty-'))
  try {
    const store = new Store(dir)
    store.update((state) => { state.install_id = 'x' })
    store.wipe()
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
