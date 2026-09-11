import assert from 'node:assert/strict'
import { test } from 'node:test'
import { electronApp, knownAppVersion, resolveAppVersion } from './platform.ts'

test('app versions preserve opaque strings and explicit missing overrides', () => {
  for (const version of ['', ' ', ' Release+α ', '😀'.repeat(32), 'v'.repeat(33)]) {
    assert.equal(resolveAppVersion({ JELTO_APP_VERSION: version }), version)
  }
  for (const version of ['', ' ', '\n', '\u0085', ' \u0085\u2000 ', 'x'.repeat(33), '\uD800']) assert.equal(knownAppVersion(version), false)
  for (const version of [' Release+α ', '😀'.repeat(32), 'Z-rollback', '\uFEFF']) assert.equal(knownAppVersion(version), true)
})

test('spec/sdk-conformance.md §5: electronApp() is main-process only', () => {
  // Plain `node` (this test runner) never sets `process.type`.
  assert.equal(electronApp(), null)
  assert.equal(electronApp({}), null)
  // A renderer or utility process must not walk away with main-process state.
  assert.equal(electronApp({ type: 'renderer', versions: { electron: '1' } }), null)
  assert.equal(electronApp({ type: 'utility' }), null)
  // The main process ('browser') is let through to the real `require('electron')`,
  // which is absent here (a devDependency this SDK deliberately does not carry),
  // so the lazy require throws and this still resolves to null rather than crashing.
  assert.equal(electronApp({ type: 'browser' }), null)
})
