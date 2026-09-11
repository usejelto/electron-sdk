import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdk, DEFAULT_ENDPOINT, resolveEndpoint } from './index.ts'

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

test('§1: a malformed NON-EMPTY value makes the SDK inactive rather than falling through', () => {
  // Falling through to the default would post traffic to a destination the
  // integrator never configured; §1 makes an invalid explicit value inactive
  // instead.
  assert.equal(resolveEndpoint('not a url', undefined), null)
  assert.equal(resolveEndpoint(undefined, '/v1/e'), null, 'a relative path cannot be posted to')
  assert.equal(resolveEndpoint(undefined, 'file:///dev/null'), null, 'the shape of the Swift half of this defect')
  // A malformed explicit value does not even fall through to a VALID environment.
  assert.equal(resolveEndpoint('not a url', 'https://e.example.com/v1/e'), null)
})

test('§1: userinfo in the URL makes the SDK inactive', () => {
  assert.equal(resolveEndpoint('https://user:pass@e.example.com/v1/e', undefined), null)
  assert.equal(resolveEndpoint('https://user@e.example.com/v1/e', undefined), null, 'a bare username is still userinfo')
  assert.equal(resolveEndpoint(undefined, 'https://user:pass@e.example.com/v1/e'), null)
})

test('§1: the default is itself an absolute http(s) URL', () => {
  assert.equal(new URL(DEFAULT_ENDPOINT).protocol, 'https:')
  assert.equal(new URL(DEFAULT_ENDPOINT).pathname, '/v1/e')
})

const KEY = 'prd_conform001'

test('§1: engine-level — an invalid endpoint sends nothing, ever, after init, track and advance', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  let requests = 0
  server.on('request', () => { requests += 1 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dir = mkdtempSync(join(tmpdir(), 'jelto-endpoint-inactive-'))
  let stderrText = ''
  const stderr = { write: (chunk: string | Buffer): boolean => ((stderrText += chunk.toString()), true) }
  try {
    // The environment is a REAL, listening server: if the engine ever fell
    // through to it, this test would see a request.
    const sdk = createSdk(
      { JELTO_ENDPOINT: `http://127.0.0.1:${port}/v1/e`, JELTO_STATE_DIR: dir, JELTO_DEBUG: '1', JELTO_NOW: '0' },
      stderr as unknown as NodeJS.WritableStream,
    )
    sdk.init(KEY, undefined, 'not a url') // an explicit, invalid override at init
    sdk.track('x')
    await sdk.advance(10_000)
    assert.equal(requests, 0, 'an invalid endpoint must never fall through to the environment default')
    assert.ok(stderrText.includes('is not an absolute URL'), stderrText)
    await sdk.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
