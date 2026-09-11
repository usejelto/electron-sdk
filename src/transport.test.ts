import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { Debug } from './debug.ts'
import { Transport } from './transport.ts'

function sink(): { log: Debug; text(): string } {
  let text = ''
  const stream = { write: (chunk: string | Buffer): boolean => ((text += chunk.toString()), true) }
  return { log: new Debug(stream as unknown as NodeJS.WritableStream, true), text: () => text }
}

test('post() never rejects, even when JELTO_MOCK is hostile enough to inject a header', async () => {
  // Nothing listens here: the point is that a malformed mock value must not
  // turn "never rejects" (transport.ts's own doc comment) into a broken
  // promise -- whatever the connection outcome, it must still be an Outcome.
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const url = `http://127.0.0.1:${port}/v1/e`

  const outcome = await new Transport(url, 'x\nX-Evil: 1').post(Buffer.from('{}'))
  assert.equal(outcome.status, 0)
  assert.equal(outcome.retryable, true)
  assert.notEqual(outcome.error, null)
})

test('a mock value outside the header-safe ASCII range is dropped, not sent, and logged once', async () => {
  const server = createServer((request, response) => {
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ mock: request.headers['x-mock'] ?? null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const { log, text } = sink()
    const outcome = await new Transport(`http://127.0.0.1:${port}/v1/e`, 'x\nX-Evil: 1', log).post(Buffer.from('{}'))
    assert.equal(outcome.status, 202)
    assert.deepEqual(JSON.parse(outcome.body.toString('utf8')), { mock: null })
    assert.ok(text().includes('header-safe ASCII range'), text())
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a well-formed mock value still rides as X-Mock, verbatim', async () => {
  const server = createServer((request, response) => {
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ mock: request.headers['x-mock'] ?? null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const outcome = await new Transport(`http://127.0.0.1:${port}/v1/e`, 'slow-503').post(Buffer.from('{}'))
    assert.equal(outcome.status, 202)
    assert.deepEqual(JSON.parse(outcome.body.toString('utf8')), { mock: 'slow-503' })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('an IPv6 literal endpoint is posted to correctly, brackets and all', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end('{}')
  })
  let bound: Server
  try {
    bound = await new Promise<Server>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '::1', () => resolve(server))
    })
  } catch (error) {
    t.skip(`could not bind ::1 in this environment: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  try {
    const address = bound.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const outcome = await new Transport(`http://[::1]:${port}/v1/e`, null).post(Buffer.from('{}'))
    assert.equal(outcome.status, 202)
  } finally {
    await new Promise<void>((resolve) => bound.close(() => resolve()))
  }
})
