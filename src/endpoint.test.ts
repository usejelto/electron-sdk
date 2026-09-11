import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ENDPOINT, resolveEndpoint } from './index.ts'

// Conformance always injects JELTO_ENDPOINT, so unit tests must cover the default
// and its precedence. Resolve URLs without sending production traffic.

test('§1: no environment and no argument targets the production host', () => {
  const resolved = resolveEndpoint(undefined, undefined)
  assert.equal(resolved, 'https://in.jelto.io/v1/e')
  assert.equal(new URL(resolved).protocol, 'https:', 'a shipped app must send over TLS')
  assert.notEqual(resolved, '', 'the rev 0.18 fallback was the empty string')
})

test('§1: the environment beats the default', () => {
  // If this inverts, the conformance host ignores the endpoint its own runner
  // handed it and posts real traffic to in.jelto.io while the suite is green.
  assert.equal(resolveEndpoint(undefined, 'http://127.0.0.1:8080/v1/e'), 'http://127.0.0.1:8080/v1/e')
})

test('§1: an explicit endpoint beats the environment', () => {
  assert.equal(
    resolveEndpoint('https://a.example.com/v1/e', 'http://127.0.0.1:8080/v1/e'),
    'https://a.example.com/v1/e',
  )
})

test('§1: an empty value is an absent value, at every level', () => {
  assert.equal(resolveEndpoint('', ''), DEFAULT_ENDPOINT)
  assert.equal(resolveEndpoint('', 'https://e.example.com/v1/e'), 'https://e.example.com/v1/e')
})

test('§1: a malformed value falls through instead of becoming an unsendable endpoint', () => {
  assert.equal(resolveEndpoint('not a url', undefined), DEFAULT_ENDPOINT)
  assert.equal(resolveEndpoint(undefined, '/v1/e'), DEFAULT_ENDPOINT, 'a relative path cannot be posted to')
  assert.equal(resolveEndpoint(undefined, 'file:///dev/null'), DEFAULT_ENDPOINT, 'the shape of the Swift half of this defect')
})

test('§1: the default is itself an absolute http(s) URL', () => {
  assert.equal(new URL(DEFAULT_ENDPOINT).protocol, 'https:')
  assert.equal(new URL(DEFAULT_ENDPOINT).pathname, '/v1/e')
})
