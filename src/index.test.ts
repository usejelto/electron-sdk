import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultStateDir } from './index.ts'

// spec/sdk-conformance.md §5: JELTO_STATE_DIR always wins, and absent that
// override, `null` (not `$HOME/.jelto`) is what "not the Electron main
// process" resolves to -- see engine.test.ts for the engine going inactive
// on a `null` stateDir, and platform.test.ts for `electronApp()` itself.

test('§5: JELTO_STATE_DIR is honoured unconditionally', () => {
  assert.equal(defaultStateDir({ JELTO_STATE_DIR: '/tmp/jelto-explicit' }), '/tmp/jelto-explicit')
  // Even a caller running under `node` (never the Electron main process) still
  // gets the override rather than being routed through electronApp().
  assert.equal(defaultStateDir({ JELTO_STATE_DIR: '/tmp/jelto-explicit', HOME: '/Users/whoever' }), '/tmp/jelto-explicit')
})

test('§5: no override outside the Electron main process resolves to no directory at all', () => {
  // This test runs under plain `node`: `process.type` is never 'browser', so
  // `electronApp()` (platform.ts) is null and there is nowhere legal to write.
  // There is no `$HOME/.jelto` fallback: `null` is the answer, not a guess.
  assert.equal(defaultStateDir({}), null)
  assert.equal(defaultStateDir({ HOME: '/Users/whoever' }), null)
  assert.equal(defaultStateDir({ JELTO_STATE_DIR: '' }), null, 'an empty override is an absent one')
})
