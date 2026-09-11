import assert from 'node:assert/strict'
import { test } from 'node:test'
import { knownAppVersion, resolveAppVersion } from './platform.ts'

test('app versions preserve opaque strings and explicit missing overrides', () => {
  for (const version of ['', ' ', ' Release+α ', '😀'.repeat(32), 'v'.repeat(33)]) {
    assert.equal(resolveAppVersion({ JELTO_APP_VERSION: version }), version)
  }
  for (const version of ['', ' ', '\n', '\u0085', ' \u0085\u2000 ', 'x'.repeat(33), '\uD800']) assert.equal(knownAppVersion(version), false)
  for (const version of [' Release+α ', '😀'.repeat(32), 'Z-rollback', '\uFEFF']) assert.equal(knownAppVersion(version), true)
})
