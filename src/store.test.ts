import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
