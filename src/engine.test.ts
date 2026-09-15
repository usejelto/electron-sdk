// Exercise the engine against a local HTTP server with the conformance clock.

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSdk, type ConformanceSdk } from './index.ts'
import { Clock, Debug, Engine } from './engine.ts'
import { Store } from './store.ts'
import { EventQueue, QUEUE_MAX_EVENTS } from './queue.ts'
import type { QueuedEvent } from './wire.ts'


interface Recorded {
  body: string
  events: Array<Record<string, unknown>>
  names: string[]
  headers: Record<string, string | string[] | undefined>
}

interface Reply {
  status?: number
  body?: string
  retryAfter?: string
  hangup?: boolean
  delayMs?: number
}

class Mock {
  readonly requests: Recorded[] = []
  connections = 0
  private readonly server: Server
  private script: Reply[] = []
  private fallback: Reply = { status: 202, body: '{}' }
  url = ''

  constructor(server: Server) {
    this.server = server
  }

  static async start(): Promise<Mock> {
    const server = createServer()
    const mock = new Mock(server)
    server.on('connection', () => {
      mock.connections += 1
    })
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        let events: Array<Record<string, unknown>> = []
        try {
          events = (JSON.parse(body) as { e: Array<Record<string, unknown>> }).e
        } catch {
          events = []
        }
        mock.requests.push({
          body,
          events,
          names: events.map((event) => String(event['n'])),
          headers: request.headers,
        })
        const reply = mock.script.shift() ?? mock.fallback
        const send = (): void => {
          if (reply.hangup === true) {
            response.socket?.destroy()
            return
          }
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (reply.retryAfter !== undefined) headers['Retry-After'] = reply.retryAfter
          response.writeHead(reply.status ?? 202, headers)
          response.end(reply.body ?? '{}')
        }
        if (reply.delayMs !== undefined) setTimeout(send, reply.delayMs).unref()
        else send()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    mock.url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/v1/e`
    return mock
  }

  answer(...replies: Reply[]): void {
    this.script.push(...replies)
  }

  always(reply: Reply): void {
    this.fallback = reply
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}


interface Rig {
  sdk: ConformanceSdk
  stderr(): string
  dir: string
}

function makeSdk(dir: string, mock: Mock, extra: NodeJS.ProcessEnv = {}): Rig {
  let text = ''
  const stream = { write: (chunk: string | Buffer): boolean => ((text += chunk.toString()), true) }
  const sdk = createSdk(
    { JELTO_ENDPOINT: mock.url, JELTO_STATE_DIR: dir, JELTO_DEBUG: '1', ...extra },
    stream as unknown as NodeJS.WritableStream,
  )
  return { sdk, stderr: () => text, dir }
}

async function withRig(
  body: (rig: Rig, mock: Mock) => Promise<void>,
  env: NodeJS.ProcessEnv = { JELTO_NOW: '1788134400000' },
  prepared?: { dir: string },
): Promise<void> {
  const mock = await Mock.start()
  const dir = prepared?.dir ?? mkdtempSync(join(tmpdir(), 'jelto-engine-'))
  const rig = makeSdk(dir, mock, env)
  try {
    await body(rig, mock)
  } finally {
    await rig.sdk.stop()
    await mock.close()
    if (prepared === undefined) rmSync(dir, { recursive: true, force: true })
  }
}

const KEY = 'prd_conform001'
const DAY = 86_400_000

test('install origin is optional host knowledge and never a heartbeat property', async () => {
  for (const origin of [undefined, 'new', 'existing', 'unknown', 'invalid'] as const) {
    await withRig(async ({ sdk }, mock) => {
      sdk.init(KEY, undefined, undefined, origin as 'new' | 'existing' | 'unknown' | undefined)
      sdk.setProps({ license: 'paid', install_origin: 'new' })
      await sdk.advance(3000)
      const events = mock.requests.flatMap(r => r.events)
      const expected = origin === 'new' || origin === 'existing' ? origin : 'unknown'
      assert.equal(sdk.exportState().install_origin, expected)
      assert.deepEqual(events.find(e => e['n'] === 'install')?.['props'], { install_origin: expected })
      assert.deepEqual(events.find(e => e['n'] === 'heartbeat')?.['props'], { license: 'paid' })
      sdk.disable()
    })
  }
})

test('pending install origin and its retry survive relaunch with a different host hint', async () => {
  await withRig(async (rig, mock) => {
    mock.always({ status: 503, retryAfter: '10' })
    rig.sdk.init(KEY, undefined, undefined, 'existing')
    await rig.sdk.advance(3000)
    const original = mock.requests[0]!.body
    const id = rig.sdk.installId()
    await rig.sdk.stop()
    const next = makeSdk(rig.dir, mock, { JELTO_NOW: '1788134403000' }).sdk
    try {
      next.init(KEY, undefined, undefined, 'new')
      assert.equal(next.installId(), id)
      assert.equal(next.exportState().install_origin, 'existing')
      mock.always({ status: 202 })
      await next.advance(15_000)
      assert.equal(mock.requests.at(-1)!.body, original)
      assert.equal(next.exportState().install_claimed, true)
      next.init(KEY, undefined, undefined, 'new')
      assert.equal(next.exportState().install_origin, 'existing')
      next.disable()
    } finally { await next.stop() }
  })
})

test('legacy pending claims keep omission instead of taking a later initialization hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-legacy-origin-'))
  try {
    new Store(dir).update(state => {
      state.install_id = '3f1b6c3e-0f2a-4d55-9b21-2f5c0f6a1234'
      state.install_due_at = '0'
    })
    await withRig(async ({ sdk }, mock) => {
      sdk.init(KEY, undefined, undefined, 'new')
      await sdk.advance(3000)
      assert.equal(sdk.exportState().install_origin, undefined)
      assert.equal(mock.requests.flatMap(r => r.events).find(e => e['n'] === 'install')?.['props'], undefined)
      sdk.disable()
    }, { JELTO_NOW: '0' }, { dir })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reset replaces pending origin with unknown; disable and init accepts a fresh host hint', async () => {
  await withRig(async ({ sdk }, mock) => {
    sdk.init(KEY, undefined, undefined, 'existing')
    await sdk.advance(0)
    const previous = sdk.installId()
    sdk.reset()
    assert.notEqual(sdk.installId(), previous)
    assert.equal(sdk.exportState().install_origin, 'unknown')
    await sdk.advance(3000)
    const installs = mock.requests.flatMap(r => r.events).filter(e => e['n'] === 'install')
    assert.equal(installs.length, 1)
    assert.deepEqual(installs[0]?.['props'], { install_origin: 'unknown' })
    sdk.disable()
    sdk.init(KEY, undefined, undefined, 'new')
    await sdk.advance(3000)
    assert.deepEqual(mock.requests.flatMap(r => r.events).filter(e => e['n'] === 'install').at(-1)?.['props'], { install_origin: 'new' })
    sdk.disable()
  })
})

test('scheduled install flushes after the init flush and final refusals do not regenerate it', async () => {
  for (const status of [202, 400, 402, 503]) {
    const dir = mkdtempSync(join(tmpdir(), 'jelto-install-deadline-'))
    const store = new Store(dir)
    store.update((state) => {
      state.install_id = '3f1b6c3e-0f2a-4d55-9b21-2f5c0f6a1234'
      state.install_due_at = '10000'
      state.last_heartbeat_day = '0'
    })
    try {
      await withRig(async (rig, mock) => {
        mock.always({ status })
        rig.sdk.init(KEY)
        await rig.sdk.advance(3000)
        assert.equal(mock.requests.length, 0)
        await rig.sdk.advance(8000)
        assert.deepEqual(mock.requests.map((request) => request.names), [['install']])
        await rig.sdk.advance(4000)
        assert.equal(mock.requests.length, status === 503 ? 2 : 1)
        if (status === 503) assert.equal(mock.requests[0]!.body, mock.requests[1]!.body)
        assert.equal(rig.sdk.exportState().install_claimed, status === 202)
        rig.sdk.disable()
      }, { JELTO_NOW: '0' }, { dir })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('fresh init configures endpoint after pre-init calls and reconfigures it after disable', async () => {
  const environment = await Mock.start()
  const explicit = await Mock.start()
  const replacement = await Mock.start()
  const dir = mkdtempSync(join(tmpdir(), 'jelto-init-endpoint-'))
  const rig = makeSdk(dir, environment, { JELTO_NOW: '0' })
  try {
    assert.equal(rig.sdk.installId(), '')
    rig.sdk.track('before')
    rig.sdk.disable()
    assert.deepEqual(readdirSync(dir), [])
    const savedID = '3f1b6c3e-0f2a-4d55-9b21-2f5c0f6a1234'
    new Store(dir).update((state) => {
      state.install_id = savedID
      state.install_claimed = true
      state.install_props = { license: 'paid' }
    })
    rig.sdk.disable() // Before init, neither Disable nor export loads or wipes existing disk state.
    assert.equal(rig.sdk.exportState().install_id, '')
    assert.equal(rig.sdk.exportState().install_props, undefined)
    assert.equal(new Store(dir).load().install_id, savedID)
    rig.sdk.init(KEY, 'desktop', explicit.url)
    rig.sdk.init(KEY, 'desktop', replacement.url) // Active init is entirely inert.
    await rig.sdk.advance(3000)
    assert.equal(rig.sdk.installId(), savedID)
    assert.deepEqual(rig.sdk.exportState().install_props, { license: 'paid' })
    assert.equal(environment.requests.length, 0)
    assert.equal(explicit.requests.length, 1)
    assert.equal(replacement.requests.length, 0)
    rig.sdk.disable()
    rig.sdk.init(KEY, 'desktop', replacement.url)
    await rig.sdk.advance(3000)
    assert.equal(replacement.requests.length, 1)
    rig.sdk.disable()
    rig.sdk.init(KEY)
    await rig.sdk.advance(3000)
    assert.equal(environment.requests.length, 1, 'omitted endpoint resolves environment/default again')
    rig.sdk.disable()
  } finally {
    await rig.sdk.stop()
    await Promise.all([environment.close(), explicit.close(), replacement.close()])
    rmSync(dir, { recursive: true, force: true })
  }
})

function seedVersion(dir: string, version: string, pending?: QueuedEvent): Store {
  const store = new Store(dir)
  store.update((state) => {
    state.install_id = '3f1b6c3e-0f2a-4d55-9b21-2f5c0f6a1234'
    state.install_claimed = true
    state.last_heartbeat_day = '20696'
    state.last_app_version = version
    state.pending_update = pending
  })
  return store
}

const interruptedUpdate: QueuedEvent = {
  id: '01991ba0-4000-7000-8000-000000000001', n: 'app_updated', t: '1788134400000',
  props: { from_version: 'A', to_version: 'B' },
  metadata: { installID: '3f1b6c3e-0f2a-4d55-9b21-2f5c0f6a1234', av: 'B', os: 'macos', osv: '14', arch: 'arm64', slug: 'original', clientVersion: 'electron/1' },
}

test('app update recovery resumes journal-only and already-queued commits with one immutable event', async () => {
  for (const queued of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'jelto-update-recovery-'))
    const store = seedVersion(dir, 'B', interruptedUpdate)
    if (queued) new EventQueue(dir, store.queuePath).recover(interruptedUpdate)
    try {
      await withRig(async ({ sdk }, mock) => {
        sdk.init(KEY, 'new-slug')
        await sdk.advance(3000)
        const updates = mock.requests.flatMap((request) => request.events).filter((event) => event['n'] === 'app_updated')
        assert.equal(updates.length, 2)
        assert.deepEqual(updates.map((event) => event['props']), [{ from_version: 'A', to_version: 'B' }, { from_version: 'B', to_version: 'C' }])
        const recovered = updates[0]!
        assert.equal(recovered['id'], interruptedUpdate.id)
        assert.equal(recovered['t'], Number(interruptedUpdate.t))
        assert.equal(recovered['av'], 'B')
        assert.equal(recovered['a'], 'original')
        assert.equal(recovered['v'], 'electron/1')
        assert.equal(recovered['osv'], '14')
        assert.equal(sdk.exportState().last_app_version, 'C')
        assert.equal(new Store(dir).load().pending_update, undefined)
      }, { JELTO_NOW: '1788134401000', JELTO_APP_VERSION: 'C' }, { dir })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('failed update commit does not advance baseline or send; a later successful commit retains observation time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-update-failure-'))
  seedVersion(dir, 'A')
  mkdirSync(join(dir, 'state.json.tmp'))
  try {
    await withRig(async ({ sdk }, mock) => {
      sdk.init(KEY)
      await sdk.advance(3000)
      assert.equal(mock.requests.length, 0)
      assert.equal(sdk.exportState().last_app_version, 'A')
      assert.equal(new Store(dir).load().last_app_version, 'A')
      rmSync(join(dir, 'state.json.tmp'), { recursive: true })
      await sdk.advance(3000)
      const update = mock.requests.flatMap((request) => request.events).find((event) => event['n'] === 'app_updated')!
      assert.equal(update['t'], 1788134400000)
      assert.deepEqual(update['props'], { from_version: 'A', to_version: 'B' })
    }, { JELTO_NOW: '1788134400000', JELTO_APP_VERSION: 'B' }, { dir })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('failed queue handoff retains the update intent and blocks dispatch until recovery succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-update-queue-failure-'))
  seedVersion(dir, 'B', interruptedUpdate)
  mkdirSync(join(dir, 'queue.jsonl.tmp'))
  try {
    await withRig(async ({ sdk }, mock) => {
      sdk.init(KEY)
      await sdk.advance(3000)
      assert.equal(mock.requests.length, 0)
      assert.equal(new Store(dir).load().pending_update?.id, interruptedUpdate.id)
      assert.equal(sdk.legacyVersion(), false)
      rmSync(join(dir, 'queue.jsonl.tmp'), { recursive: true })
      await sdk.advance(3000)
      const updates = mock.requests.flatMap((request) => request.events).filter((event) => event['n'] === 'app_updated')
      assert.equal(updates.length, 1)
      assert.equal(updates[0]!['id'], interruptedUpdate.id)
      assert.equal(new Store(dir).load().pending_update, undefined)
    }, { JELTO_NOW: '1788134400000', JELTO_APP_VERSION: 'B' }, { dir })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('recovery does not resurrect an update evicted after queue handoff but before intent retirement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-update-eviction-'))
  const store = seedVersion(dir, 'B', interruptedUpdate)
  const queue = new EventQueue(dir, store.queuePath)
  assert.equal(queue.recover(interruptedUpdate), true)
  // A failed state write leaves the intent pending while ordinary tracking continues.
  for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) {
    queue.append({ id: `new-${i}`, n: 'ordinary', t: interruptedUpdate.t })
  }
  assert.equal(queue.contains('app_updated'), false)
  try {
    await withRig(async ({ sdk }, mock) => {
      sdk.init(KEY)
      await sdk.advance(3000)
      assert.equal(mock.requests.flatMap((request) => request.names).includes('app_updated'), false)
      assert.equal(new Store(dir).load().pending_update, undefined)
    }, { JELTO_NOW: '1788134400000', JELTO_APP_VERSION: 'B' }, { dir })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function heartbeats(mock: Mock): number {
  return mock.requests.flatMap((request) => request.names).filter((name) => name === 'heartbeat').length
}


test('C5: before init nothing happens — no request, no socket, no file', async () => {
  await withRig(async (rig, mock) => {
    for (let i = 0; i < 10; i += 1) rig.sdk.track('x')
    await rig.sdk.advance(5_000)
    assert.equal(mock.requests.length, 0)
    assert.equal(mock.connections, 0)
    // §3.2: dumpstate before init prints an empty export and leaves the state
    // directory as empty as it found it.
    assert.deepEqual(rig.sdk.exportState(), {
      install_id: '',
      install_claimed: false,
      queue: { bytes: 0, events: [] },
    })
    assert.deepEqual(readdirSync(rig.dir), [])
  })
})

test('C2/C3: one heartbeat per UTC day, and the install id survives a relaunch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-engine-'))
  const mock = await Mock.start()
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  try {
    const first = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000) })
    first.sdk.init(KEY)
    await first.sdk.advance(3_000)
    const id = first.sdk.installId()
    assert.match(id, v4)
    assert.match(first.sdk.exportState().install_id, v4)
    // The immediate install shares the first batch; count only the daily heartbeat.
    assert.equal(heartbeats(mock), 1)
    await first.sdk.stop()

    // Same day, a new process: no heartbeat (C3's third init).
    const second = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000) })
    second.sdk.init(KEY)
    await second.sdk.advance(3_000)
    assert.equal(second.sdk.installId(), id)
    assert.equal(heartbeats(mock), 1)
    await second.sdk.stop()

    // The next UTC day: one more.
    const third = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000 + DAY) })
    third.sdk.init(KEY)
    await third.sdk.advance(3_000)
    assert.equal(heartbeats(mock), 2)
    assert.equal(third.sdk.exportState().last_heartbeat_day, '20697')
    await third.sdk.stop()
  } finally {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C15/C15b: `t` reaches the wire as the host clock says, uncorrected', async () => {
  for (const pin of ['0', '2103753600000', '-14256000000', '99999999999999999999']) {
    await withRig(
      async (rig, mock) => {
        rig.sdk.init(KEY)
        await rig.sdk.advance(3_000)
        assert.equal(mock.requests.length, 1)
        const body = mock.requests[0]!.body
        // Asserted on the BODY BYTES, not on a parsed value: JSON.parse would
        // round the fourth pin into 100000000000000000000.
        assert.ok(body.includes(`"t":${pin},`), body)
        assert.equal(rig.sdk.exportState().queue.events.length, 0)
      },
      { JELTO_NOW: pin },
    )
  }
})

test('C4/C4c: one install, enqueued immediately, resumed rather than redrawn, claimed on the 202', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-engine-'))
  const mock = await Mock.start()
  try {
    // C4c: the process ends before the initial flush.
    const first = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000) })
    first.sdk.init(KEY)
    await first.sdk.advance(0)
    const dueAt = first.sdk.exportState().install_due_at
    assert.equal(dueAt, '1788134400000')
    const queued = first.sdk.exportState().queue.events.filter((event) => event.n === 'install')
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.t, '1788134400000')
    assert.equal(first.sdk.exportState().install_claimed, false)
    await first.sdk.stop()

    // A relaunch seven hours later RESUMES that deadline.
    const second = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000 + 25_200_000) })
    second.sdk.init(KEY)
    await second.sdk.advance(3_000)
    assert.equal(second.sdk.exportState().install_due_at, dueAt)
    const installs = mock.requests.flatMap((r) => r.names).filter((n) => n === 'install')
    assert.deepEqual(installs, ['install'])
    assert.equal(second.sdk.exportState().install_claimed, true)
    // The install carries only the coarse origin, with no attribution payload.
    const event = mock.requests.flatMap((r) => r.events).find((e) => e['n'] === 'install')
    assert.deepEqual(Object.keys(event ?? {}).sort(), ['arch', 'av', 'id', 'iid', 'n', 'os', 'osv', 'props', 's', 't', 'v'])
    assert.deepEqual(event?.['props'], { install_origin: 'unknown' })
    await second.sdk.stop()

    // A further init sends no second install.
    const third = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000 + 25_200_000) })
    third.sdk.init(KEY)
    await third.sdk.advance(25_200_000)
    assert.equal(mock.requests.flatMap((r) => r.names).filter((n) => n === 'install').length, 1)
    await third.sdk.stop()
  } finally {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C4b: thirty simulated days without a 202 claim it, and the queue holds ONE install', async () => {
  await withRig(async (rig, mock) => {
    mock.always({ hangup: true })
    rig.sdk.init(KEY)
    await rig.sdk.advance(25_200_000)
    for (let day = 0; day < 31; day += 1) await rig.sdk.advance(DAY)
    const state = rig.sdk.exportState()
    assert.equal(state.install_claimed, true)
    assert.equal(state.queue.events.filter((event) => event.n === 'install').length, 1)
    assert.ok(mock.requests.length > 0, 'the events really were offered')
  })
})

test('C7: a batch is capped at 100 events, and the queue drains in order', async () => {
  await withRig(async (rig, mock) => {
    rig.sdk.init(KEY)
    for (let i = 0; i < 250; i += 1) rig.sdk.track(`x${i}`)
    await rig.sdk.advance(6_000)
    assert.equal(mock.requests.length, 3)
    assert.equal(mock.requests[0]?.events.length, 100)
    assert.equal(mock.requests[1]?.events.length, 100)
    assert.equal(mock.requests[2]?.events.length, 52) // 250 tracks + the heartbeat + the install
    assert.equal(mock.requests[0]?.names[0], 'heartbeat')
    assert.deepEqual(mock.requests.flatMap((r) => r.names).filter((name) => name.startsWith('x')),
      Array.from({ length: 250 }, (_, i) => `x${i}`))
  })
})

test('C9: a 400 is final — one request with x, and y in a fresh batch', async () => {
  await withRig(async (rig, mock) => {
    mock.answer({ status: 400, body: '{"error":"malformed"}' })
    rig.sdk.init(KEY)
    rig.sdk.track('x')
    await rig.sdk.advance(5_000)
    rig.sdk.track('y')
    await rig.sdk.advance(6_000)
    assert.equal(mock.requests.length, 2)
    assert.deepEqual(mock.requests[0]?.names, ['heartbeat', 'x', 'install'])
    assert.deepEqual(mock.requests[1]?.names, ['y'])
    assert.equal(rig.sdk.exportState().backoff_step_ms, undefined)
  })
})

test('C9b: a 402 is final too — no retry, no backoff loop, and one line names it', async () => {
  await withRig(async (rig, mock) => {
    mock.always({ status: 402, body: '{"error":"payment_required"}' })
    rig.sdk.init(KEY)
    rig.sdk.track('x')
    await rig.sdk.advance(5_000)
    rig.sdk.track('y')
    await rig.sdk.advance(6_000)
    assert.equal(mock.requests.length, 2)
    assert.deepEqual(mock.requests.flatMap((r) => r.names), ['heartbeat', 'x', 'install', 'y'])
    assert.equal(rig.sdk.exportState().backoff_step_ms, undefined)
    assert.ok(rig.stderr().includes('payment_required'), rig.stderr())
  })
})

test('C8: a retryable refusal resends the SAME batch with the SAME ids', async () => {
  await withRig(async (rig, mock) => {
    mock.always({ status: 503, body: '{}', retryAfter: '2' })
    rig.sdk.init(KEY)
    rig.sdk.track('x')
    await rig.sdk.advance(5_000)
    assert.equal(mock.requests.length, 1)
    const first = mock.requests[0]!.events.map((event) => event['id'])
    // The batch stays queued, and the schedule is persisted as a DEADLINE.
    const state = rig.sdk.exportState()
    assert.equal(state.backoff_step_ms, 2_000)
    assert.ok(state.backoff_next_at !== undefined)
    assert.equal(state.queue.events.length, 3)
    // Past the deadline, the identical batch goes out again.
    await rig.sdk.advance(4_000)
    assert.ok(mock.requests.length >= 2)
    assert.deepEqual(mock.requests[1]!.events.map((event) => event['id']), first)
  })
})

test('C8: the schedule is persisted — a new process does not restart at 1 s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-engine-'))
  const mock = await Mock.start()
  try {
    mock.always({ hangup: true })
    const first = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000) })
    first.sdk.init(KEY)
    first.sdk.track('x')
    await first.sdk.advance(5_000)
    const step = first.sdk.exportState().backoff_step_ms
    assert.equal(step, 2_000)
    await first.sdk.stop()

    const second = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000) })
    second.sdk.init(KEY)
    assert.equal(second.sdk.exportState().backoff_step_ms, 2_000)
    await second.sdk.stop()
  } finally {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C16: the switch pauses, then ONE heartbeat alone, then the queue drains', async () => {
  await withRig(async (rig, mock) => {
    const now = 1788134400000
    rig.sdk.init(KEY)
    // Retain C16's clock advance; the initial flush accepts the immediate install.
    await rig.sdk.advance(25_200_000)
    assert.equal(mock.requests.length, 1)

    // The batch carrying the five x's takes the switch, 60 s ahead of the host.
    const until = Math.floor((now + 25_200_000 + 60_000) / 1000)
    mock.answer({
      status: 202,
      body: JSON.stringify({
        rejected: [0, 1, 2, 3, 4].map((i) => ({ i, reason: 'stopped' })),
        stop: { until, scope: 'app' },
      }),
    })
    for (let i = 0; i < 5; i += 1) rig.sdk.track('x')
    await rig.sdk.advance(30_000)
    assert.equal(mock.requests.length, 2, 'after the stop response, no request for 60 s')
    assert.equal(rig.sdk.exportState().stop_until, String(until * 1000))
    assert.equal(rig.sdk.exportState().stop_probe_due, true)

    rig.sdk.track('y')
    await rig.sdk.advance(40_000)
    assert.ok(mock.requests.length >= 4, String(mock.requests.length))
    assert.deepEqual(mock.requests[2]?.names, ['heartbeat'], 'one heartbeat, ALONE in its batch')
    assert.deepEqual(mock.requests[3]?.names, ['y'])
    // The five x's were in the batch the switch answered; a 202 accepted that
    // envelope however many events it rejected, so nothing re-queues them.
    assert.deepEqual(mock.requests.flatMap((r) => r.names), [
      'heartbeat', 'install', 'x', 'x', 'x', 'x', 'x', 'heartbeat', 'y',
    ])
    const text = rig.stderr()
    assert.ok(text.includes('kill switch: no request until'), text)
    assert.ok(text.includes('kill switch elapsed'), text)
    assert.ok(!text.includes('is already past'), 'the switch was armed on an `until` in the FUTURE')
  })
})

test('C16: a stop whose `until` has already elapsed says so', async () => {
  await withRig(async (rig, mock) => {
    mock.answer({ status: 202, body: '{"stop":{"until":1,"scope":"app"}}' })
    rig.sdk.init(KEY)
    await rig.sdk.advance(3_000)
    assert.ok(rig.stderr().includes('is already past (now '), rig.stderr())
  })
})

test('C16b: an app SDK ignores a stop scoped to web', async () => {
  await withRig(async (rig, mock) => {
    const until = Math.floor(1788134400000 / 1000) + 60
    mock.answer({ status: 202, body: JSON.stringify({ stop: { until, scope: 'web' } }) })
    rig.sdk.init(KEY)
    await rig.sdk.advance(3_000)
    rig.sdk.track('y')
    await rig.sdk.advance(6_000)
    assert.equal(mock.requests.length, 2)
    assert.deepEqual(mock.requests.flatMap((r) => r.names), ['heartbeat', 'install', 'y'])
    assert.equal(rig.sdk.exportState().stop_until, undefined)
    assert.ok(rig.stderr().includes('ignoring a stop scoped to web'), rig.stderr())
  })
})

test('C17: the exact body reaches stderr before it is sent', async () => {
  await withRig(async (rig, mock) => {
    rig.sdk.init(KEY)
    rig.sdk.track('x')
    await rig.sdk.advance(6_000)
    assert.equal(mock.requests.length, 1)
    assert.ok(rig.stderr().includes(mock.requests[0]!.body), rig.stderr())
  })
})

test('C18/C22d: disable wipes the queue, the id, the props and the directory', async () => {
  await withRig(async (rig, mock) => {
    rig.sdk.init(KEY)
    rig.sdk.setProps({ license: 'paid' })
    rig.sdk.track('x')
    rig.sdk.disable()
    assert.equal(rig.sdk.installId(), '')
    rig.sdk.track('y')
    await rig.sdk.advance(6_000)
    assert.equal(mock.requests.length, 0, 'y never sent — and nor was x')
    assert.deepEqual(readdirSync(rig.dir), [])
    const state = rig.sdk.exportState()
    assert.equal(state.install_id, '')
    assert.deepEqual(state.queue.events, [])
    assert.equal(state.install_props, undefined)
  })
})

test('C20: onboarding IS track, and its event is congruent with the sugar-free call', async () => {
  await withRig(async (rig, mock) => {
    rig.sdk.init(KEY)
    rig.sdk.onboarding('permissions', 'ok')
    rig.sdk.onboarding('driver', 'fail', 'no_kext')
    rig.sdk.onboarding('tour', 'skip')
    rig.sdk.track('onboarding:permissions', { status: 'ok' })
    await rig.sdk.advance(6_000)
    const events = mock.requests[0]!.events
    assert.deepEqual(mock.requests[0]!.names, [
      'heartbeat', 'onboarding:permissions', 'onboarding:driver', 'onboarding:tour', 'onboarding:permissions', 'install',
    ])
    assert.deepEqual(events[1]?.['props'], { status: 'ok' })
    assert.deepEqual(events[2]?.['props'], { status: 'fail', reason: 'no_kext' })
    assert.deepEqual(events[3]?.['props'], { status: 'skip' })
    // Congruent but for `id` and `t`, which wire §3 gives every event its own of.
    const left = { ...events[1] } as Record<string, unknown>
    const right = { ...events[4] } as Record<string, unknown>
    for (const key of ['id', 't']) {
      delete left[key]
      delete right[key]
    }
    assert.deepEqual(left, right)
  })
})

test('C20b/W2/W3/C22c: every client-side drop keeps its event off the wire', async () => {
  await withRig(async (rig, mock) => {
    rig.sdk.init(KEY)
    rig.sdk.track('Bad Name!')
    rig.sdk.track('x', { k: 'a'.repeat(201) })
    const twentyOne: Record<string, string> = {}
    for (let i = 1; i <= 21; i += 1) twentyOne[`k${i}`] = 'a'
    rig.sdk.track('y', twentyOne)
    rig.sdk.onboarding('Bad Step!', 'ok')
    rig.sdk.onboarding('x', 'ok', 'Free text reason')
    rig.sdk.setProps({ Email: 'x@y.z' })
    rig.sdk.setProps({ license: 'a'.repeat(30) })
    rig.sdk.track('good_name')
    await rig.sdk.advance(6_000)
    assert.deepEqual(mock.requests.flatMap((r) => r.names), ['heartbeat', 'good_name', 'install'])
    // C22c: neither reached the wire, and no change means no extra heartbeat.
    assert.equal(mock.requests[0]?.events[0]?.['props'], undefined)
    assert.equal(mock.requests.length, 1)
  })
})

test('C21: the registered slug rides as `a`, and is absent without the argument', async () => {
  await withRig(async (rig, mock) => {
    rig.sdk.init(KEY, 'mac')
    await rig.sdk.advance(3_000)
    assert.equal(mock.requests[0]?.events[0]?.['a'], 'mac')
  })
  await withRig(async (rig, mock) => {
    rig.sdk.init(KEY)
    await rig.sdk.advance(3_000)
    assert.equal('a' in (mock.requests[0]?.events[0] ?? {}), false)
  })
})

test('C22/C22b: props persist, ride every heartbeat, and only a CHANGE sends one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-engine-'))
  const mock = await Mock.start()
  try {
    const first = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000) })
    first.sdk.init(KEY)
    first.sdk.setProps({ license: 'trial' })
    await first.sdk.advance(3_000)
    assert.equal(mock.requests[0]?.events[0]?.['props'] instanceof Object, true)
    assert.deepEqual(mock.requests[0]?.events[0]?.['props'], { license: 'trial' })

    first.sdk.setProps({ license: 'paid', edition: 'pro' })
    await first.sdk.advance(3_000)
    assert.equal(mock.requests.length, 2)
    assert.deepEqual(mock.requests[1]?.events[0]?.['props'], { edition: 'pro', license: 'paid' })

    // C22b: the same value twice is not a change.
    first.sdk.setProps({ license: 'paid' })
    await first.sdk.advance(3_000)
    assert.equal(mock.requests.length, 2)
    await first.sdk.stop()

    // C22: a new process on a NEW DAY still carries both.
    const second = makeSdk(dir, mock, { JELTO_NOW: String(1788134400000 + DAY) })
    second.sdk.init(KEY)
    await second.sdk.advance(3_000)
    assert.equal(mock.requests.length, 3)
    assert.deepEqual(mock.requests[2]?.events[0]?.['props'], { edition: 'pro', license: 'paid' })
    assert.deepEqual(second.sdk.exportState().install_props, { edition: 'pro', license: 'paid' })
    await second.sdk.stop()
  } finally {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C10: garbage, a 500, an oversized body and a timeout, all in silence', async () => {
  await withRig(
    async (rig, mock) => {
      mock.answer(
        { status: 202, body: 'not json at all' },
        { status: 500, body: '{"error":"internal"}' },
        { status: 202, body: `{"pad":"${'a'.repeat(2_000_000)}"}` },
        { status: 202, body: '{}', delayMs: 6_000 },
      )
      rig.sdk.init(KEY)
      for (let i = 0; i < 300; i += 1) rig.sdk.track(`x${i}`)
      await rig.sdk.advance(12_000)
      assert.ok(mock.requests.length >= 4, String(mock.requests.length))
      assert.equal(rig.stderr(), '', 'nothing reaches stderr without JELTO_DEBUG=1')
    },
    { JELTO_NOW: '1788134400000', JELTO_DEBUG: '' },
  )
})

test('spec/sdk-conformance.md §3.2: the export carries these keys and no others', async () => {
  await withRig(async (rig, mock) => {
    mock.always({ status: 503, body: '{}', retryAfter: '2' })
    rig.sdk.init(KEY)
    rig.sdk.setProps({ license: 'trial' })
    rig.sdk.track('x')
    await rig.sdk.advance(6_000)
    const state = rig.sdk.exportState()
    assert.deepEqual(Object.keys(state).sort(), [
      'backoff_next_at',
      'backoff_step_ms',
      'install_claimed',
      'install_due_at',
      'install_first_try',
      'install_id',
      'install_origin',
      'install_props',
      'last_heartbeat_day',
      'queue',
    ])
    // Every instant is a DECIMAL STRING; `backoff_step_ms` is a duration and a
    // JSON number; the two booleans are booleans.
    assert.equal(typeof state.install_claimed, 'boolean')
    assert.equal(typeof state.backoff_step_ms, 'number')
    for (const key of ['last_heartbeat_day', 'install_due_at', 'backoff_next_at'] as const) {
      assert.match(String(state[key]), /^-?[0-9]+$/, key)
    }
    assert.deepEqual(Object.keys(state.queue).sort(), ['bytes', 'events'])
    assert.equal(typeof state.queue.bytes, 'number')
    for (const event of state.queue.events) {
      assert.deepEqual(Object.keys(event).sort(), ['id', 'n', 't'])
      assert.equal(typeof event.t, 'string')
    }
    // The counter refhost keeps is NOT a fact of the contract (§3.2).
    assert.ok(!('backoff_failures' in state))
    // And it round-trips as canonical JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
  })
})

test('C1: init returns before any of the work, and a thousand tracks still stop', async () => {
  await withRig(
    async (rig, mock) => {
      const started = process.hrtime.bigint()
      rig.sdk.init(KEY)
      const micros = Number(process.hrtime.bigint() - started) / 1000
      assert.ok(micros < 5_000, `init took ${micros} us`)
      for (let i = 0; i < 1000; i += 1) rig.sdk.track('x')
      const stopStart = Date.now()
      await rig.sdk.stop()
      assert.ok(Date.now() - stopStart < 1_000, 'the termination flush is bounded')
      assert.ok(mock.requests.length > 0)
      assert.ok(existsSync(rig.dir))
    },
    {},
  )
})

test('the SDK never throws into the host, whatever it is handed', async () => {
  await withRig(async (rig) => {
    const sdk = rig.sdk as unknown as {
      track(name: unknown, props?: unknown): void
      setProps(props: unknown): void
      onboarding(a: unknown, b: unknown, c?: unknown): void
    }
    rig.sdk.init(KEY)
    assert.doesNotThrow(() => sdk.track(''))
    assert.doesNotThrow(() => sdk.track('x', { k: null }))
    assert.doesNotThrow(() => sdk.track('x', { k: { nested: true } }))
    assert.doesNotThrow(() => sdk.setProps({ license: null }))
    assert.doesNotThrow(() => sdk.onboarding('x', 'ok', 123))
    assert.doesNotThrow(() => rig.sdk.reset())
    assert.doesNotThrow(() => rig.sdk.installId())
  })
})

test('spec/wire-v1.md §2: a key outside the grammar is refused, and init stays inert', async () => {
  await withRig(async (rig, mock) => {
    rig.sdk.init('not-a-product-key')
    rig.sdk.track('x')
    await rig.sdk.advance(6_000)
    assert.equal(mock.requests.length, 0)
    assert.equal(rig.sdk.installId(), '')
    assert.ok(rig.stderr().includes('drop init: product key must match'), rig.stderr())
    // The refusal did not consume `started`: a later, valid init still works.
    rig.sdk.init(KEY)
    await rig.sdk.advance(6_000)
    assert.ok(mock.requests.length > 0)
  })
})

test('spec/sdk-conformance.md §5: a null state directory leaves the engine permanently inactive', async () => {
  let text = ''
  const stderr = { write: (chunk: string | Buffer): boolean => ((text += chunk.toString()), true) }
  const engine = new Engine({
    endpoint: 'https://example.invalid/v1/e',
    stateDir: null,
    clock: new Clock(0n),
    log: new Debug(stderr as unknown as NodeJS.WritableStream, true),
    stderr: stderr as unknown as NodeJS.WritableStream,
    mock: null,
    clientVersion: null,
    env: {},
  })
  engine.init(KEY)
  engine.track('x')
  await engine.advance(10_000)
  assert.equal(engine.installId(), '')
  assert.deepEqual(engine.exportState(), { install_id: '', install_claimed: false, queue: { bytes: 0, events: [] } })
  await engine.stop()
})

test('an install_id outside the canonical UUID grammar is replaced, not trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jelto-engine-badid-'))
  new Store(dir).update((state) => {
    state.install_id = 'not-a-uuid'
  })
  const v4ish = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  try {
    await withRig(async (rig) => {
      rig.sdk.init(KEY)
      await rig.sdk.advance(0)
      const id = rig.sdk.installId()
      assert.match(id, v4ish)
      assert.notEqual(id, 'not-a-uuid')
      assert.match(new Store(dir).load().install_id, v4ish)
    }, { JELTO_NOW: '0' }, { dir })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a JELTO_MOCK value hostile to headers is dropped, not fatal — events still get delivered', async () => {
  await withRig(
    async (rig, mock) => {
      rig.sdk.init(KEY)
      rig.sdk.track('x')
      await rig.sdk.advance(6_000)
      assert.ok(mock.requests.length > 0, 'the batch was still sent despite the malformed JELTO_MOCK')
      assert.equal(mock.requests[0]?.headers['x-mock'], undefined)
      assert.ok(rig.stderr().includes('header-safe ASCII range'), rig.stderr())
    },
    { JELTO_NOW: '0', JELTO_MOCK: 'x\nX-Evil: 1' },
  )
})

class FlakyClock extends Clock {
  calls = 0
  override now(): bigint {
    this.calls += 1
    // Calls 1-2 are `ensureBootstrapped`'s own (its `now()` and `dayIndex()`,
    // which calls `now()` again); call 3 is the FIRST inside `pumpLoop` itself,
    // which is the crash this test means to exercise.
    if (this.calls === 3) throw new Error('clock exploded')
    return super.now()
  }
}

test('a pump loop that throws clears pumpActive and logs once, rather than wedging forever', async () => {
  let text = ''
  const stderr = { write: (chunk: string | Buffer): boolean => ((text += chunk.toString()), true) }
  const dir = mkdtempSync(join(tmpdir(), 'jelto-engine-pumpcrash-'))
  const engine = new Engine({
    endpoint: 'https://example.invalid/v1/e',
    stateDir: dir,
    clock: new FlakyClock(0n),
    log: new Debug(stderr as unknown as NodeJS.WritableStream, true),
    stderr: stderr as unknown as NodeJS.WritableStream,
    mock: null,
    clientVersion: null,
    env: {},
  })
  try {
    engine.init(KEY)
    // Let the setImmediate bootstrap and the crashing pump iteration run.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.match(text, /pump loop stopped unexpectedly: clock exploded/)
    assert.equal(text.match(/pump loop stopped unexpectedly/g)?.length, 1, 'logged exactly once')
    // `stop()` must not hang waiting on a pump promise that already settled.
    const started = Date.now()
    await engine.stop()
    assert.ok(Date.now() - started < 2_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
