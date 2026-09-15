// A recording fake verifies one reply after each SDK command completes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, type HostSdk, type PropValue } from './dispatch.ts'

interface Call {
  method: string
  args: unknown[]
}

interface Fake extends HostSdk {
  calls: Call[]
}

function fakeSdk(overrides: Partial<HostSdk> = {}): Fake {
  const calls: Call[] = []
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
  }
  const base: HostSdk = {
    init: (key: string, app?: string) => record('init', key, app),
    track: (name: string, props?: Record<string, PropValue>) => record('track', name, props),
    onboarding: (step: string, status: string, reason?: string) =>
      record('onboarding', step, status, reason),
    setProps: (props: Record<string, PropValue>) => record('setProps', props),
    installId: () => {
      record('installId')
      return 'fake-install-id'
    },
    reset: () => record('reset'),
    disable: () => record('disable'),
    legacyVersion: () => { record('legacyVersion'); return true },
    exportState: () => {
      record('exportState')
      return { install_id: '', install_claimed: false, queue: { bytes: 0, events: [] } }
    },
    advance: async (ms: number) => {
      record('advance', ms)
    },
    stop: async () => {
      record('stop')
    },
  }
  return Object.assign({ calls }, base, overrides)
}

test('init reports the microseconds C1 reads', async () => {
  const sdk = fakeSdk()
  let clock = 1_000_000n
  const dispatcher = createDispatcher(sdk, {
    nowNs: () => {
      const value = clock
      clock += 3_500_000n // 3.5 ms between the two reads
      return value
    },
  })
  const { reply, terminate } = await dispatcher.dispatch('init prd_conform001 mac')
  assert.deepEqual(reply, { cmd: 'init', ok: true, us: 3500 })
  assert.equal(terminate, false)
  assert.deepEqual(sdk.calls, [{ method: 'init', args: ['prd_conform001', 'mac'] }])
})

test('init without a slug passes none', async () => {
  const sdk = fakeSdk()
  const dispatcher = createDispatcher(sdk)
  const { reply } = await dispatcher.dispatch('init prd_conform001')
  assert.equal(reply.ok, true)
  assert.deepEqual(sdk.calls[0], { method: 'init', args: ['prd_conform001', undefined] })
})

test('conformance origin hint is passed through the public init option', async () => {
  let received: unknown[] = []
  const sdk = fakeSdk({ init: (...args) => { received = args } })
  const dispatcher = createDispatcher(sdk, { installOrigin: 'existing' })
  await dispatcher.dispatch('init prd_conform001 desktop')
  assert.deepEqual(received, ['prd_conform001', 'desktop', undefined, 'existing'])
})

test('a command missing its argument is refused with its usage', async () => {
  const sdk = fakeSdk()
  const dispatcher = createDispatcher(sdk)
  const cases: Array<[string, string]> = [
    ['init', 'init <key> [app]'],
    ['track', 'track <name> [json-props]'],
    ['onboarding', 'onboarding <step> <ok|fail|skip> [reason]'],
    ['onboarding step', 'onboarding <step> <ok|fail|skip> [reason]'],
    ['setprops', 'setprops <json>'],
    ['sleep', 'sleep <ms>: a whole number >= 0'],
    ['sleep -1', 'sleep <ms>: a whole number >= 0'],
    ['sleep abc', 'sleep <ms>: a whole number >= 0'],
    ['sleep 1.5', 'sleep <ms>: a whole number >= 0'],
  ]
  for (const [line, usage] of cases) {
    const { reply } = await dispatcher.dispatch(line)
    assert.equal(reply.ok, false, `${line} should be refused`)
    assert.equal(reply.error, usage)
  }
  assert.deepEqual(sdk.calls, [], 'a refused command must not reach the SDK')
})

test('an unknown command names the ten §3 has', async () => {
  const { reply } = await createDispatcher(fakeSdk()).dispatch('frobnicate x')
  assert.equal(reply.cmd, 'frobnicate')
  assert.equal(reply.ok, false)
  assert.match(reply.error ?? '', /^unknown command; spec\/sdk-conformance\.md §3 has init, /)
})

test('track carries its props, and reports without them too', async () => {
  const sdk = fakeSdk()
  const dispatcher = createDispatcher(sdk)
  assert.equal((await dispatcher.dispatch('track x')).reply.ok, true)
  assert.equal((await dispatcher.dispatch('track e.c:x {"n":1.5,"ok":true}')).reply.ok, true)
  assert.deepEqual(sdk.calls, [
    { method: 'track', args: ['x', undefined] },
    { method: 'track', args: ['e.c:x', { n: 1.5, ok: true }] },
  ])
})

test('a props token that is not a JSON object is the one refusal, and the SDK is not called', async () => {
  const sdk = fakeSdk()
  const { reply } = await createDispatcher(sdk).dispatch('track x {nope}')
  assert.equal(reply.ok, false)
  assert.match(reply.error ?? '', /props must be a JSON object/)
  assert.deepEqual(sdk.calls, [])
})

test('onboarding passes what it was given and validates nothing', async () => {
  const sdk = fakeSdk()
  const dispatcher = createDispatcher(sdk)
  await dispatcher.dispatch('onboarding permissions ok')
  await dispatcher.dispatch('onboarding x ok "Free text reason"')
  await dispatcher.dispatch('onboarding "Bad Step!" nonsense')
  assert.deepEqual(sdk.calls, [
    { method: 'onboarding', args: ['permissions', 'ok', undefined] },
    { method: 'onboarding', args: ['x', 'ok', 'Free text reason'] },
    { method: 'onboarding', args: ['Bad Step!', 'nonsense', undefined] },
  ])
})

test('installid prints what the SDK holds, empty included', async () => {
  const dispatcher = createDispatcher(fakeSdk())
  assert.deepEqual((await dispatcher.dispatch('installid')).reply, {
    cmd: 'installid',
    ok: true,
    value: 'fake-install-id',
  })
  const empty = createDispatcher(fakeSdk({ installId: () => '' }))
  assert.deepEqual((await empty.dispatch('installid')).reply, {
    cmd: 'installid',
    ok: true,
    value: '',
  })
})

test('dumpstate passes the export through untouched', async () => {
  // §3.2: "the host may re-encode what the SDK already holds, and may not
  // compute, default or infer anything it does not." An export missing a fact
  // reaches the runner missing that fact.
  const exported = { install_id: 'abc', install_claimed: true, queue: { bytes: 0, events: [] } }
  const dispatcher = createDispatcher(fakeSdk({ exportState: () => exported }))
  const { reply } = await dispatcher.dispatch('dumpstate')
  assert.equal(reply.cmd, 'dumpstate')
  assert.equal(reply.ok, true)
  assert.equal(reply.state, exported)
  assert.equal('value' in reply, false, '§3.1 keeps `value` and `state` apart')
})

test('dumpstate does not fill a gap in the export', async () => {
  const dispatcher = createDispatcher(fakeSdk({ exportState: () => ({}) }))
  const { reply } = await dispatcher.dispatch('dumpstate')
  assert.deepEqual(reply.state, {})
})

test('reset and disable are one call and one reply each', async () => {
  const sdk = fakeSdk()
  const dispatcher = createDispatcher(sdk)
  assert.deepEqual((await dispatcher.dispatch('reset')).reply, { cmd: 'reset', ok: true })
  assert.deepEqual((await dispatcher.dispatch('disable')).reply, { cmd: 'disable', ok: true })
  assert.deepEqual(sdk.calls, [{ method: 'reset', args: [] }, { method: 'disable', args: [] }])
})

test('sleep delegates to the SDK clock and replies only when it resolves', async () => {
  const order: string[] = []
  let release: (() => void) | undefined
  const sdk = fakeSdk({
    advance: (ms: number) =>
      new Promise<void>((resolve) => {
        order.push(`advance:${ms}`)
        release = () => {
          order.push('advanced')
          resolve()
        }
      }),
  })
  const pending = createDispatcher(sdk).dispatch('sleep 25200000')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(order, ['advance:25200000'], 'the reply must not precede the advance')
  release?.()
  const { reply } = await pending
  assert.deepEqual(order, ['advance:25200000', 'advanced'])
  assert.deepEqual(reply, { cmd: 'sleep', ok: true })
})

test('exit stops the SDK before it answers, and asks for termination', async () => {
  const order: string[] = []
  const sdk = fakeSdk({
    stop: async () => {
      order.push('stop')
    },
  })
  const dispatcher = createDispatcher(sdk)
  await dispatcher.dispatch('track x')
  await dispatcher.dispatch('track y')
  const { reply, terminate } = await dispatcher.dispatch('exit')
  order.push('reply')
  assert.deepEqual(order, ['stop', 'reply'])
  assert.equal(terminate, true)
  assert.equal(reply.cmd, 'exit')
  assert.equal(reply.ok, true)
  assert.equal(reply.tracks, 2)
  assert.equal(typeof reply.track_p50_us, 'number')
  assert.equal(typeof reply.track_p99_us, 'number')
})

test('the exit summary reports the heap delta it actually measured', async () => {
  let heap = 4 * 1024 * 1024
  const dispatcher = createDispatcher(fakeSdk(), { heapUsed: () => heap })
  heap += 512 * 1024
  const { reply } = await dispatcher.dispatch('exit')
  assert.equal(reply.heap_delta_kib, 512)
  assert.equal(reply.tracks, 0)
  assert.equal('track_p50_us' in reply, false, 'no tracks, no percentile to report')
})

test('a stop that throws still terminates', async () => {
  const dispatcher = createDispatcher(
    fakeSdk({
      stop: async () => {
        throw new Error('flush wedged')
      },
    }),
  )
  const { reply, terminate } = await dispatcher.dispatch('exit')
  assert.equal(terminate, true, 'C1 gives the process one second whatever stop() did')
  assert.equal(reply.ok, false)
  assert.equal(reply.error, 'flush wedged')
})

test('an SDK that throws is reported on the reply, never on stderr', async () => {
  // The SDK never throws into the host. If one does, the runner has to be
  // able to see it -- and C10 asserts stderr is byte-empty without
  // JELTO_DEBUG, so the reply is the only channel left.
  const dispatcher = createDispatcher(
    fakeSdk({
      track: () => {
        throw new Error('boom')
      },
    }),
  )
  const { reply, terminate } = await dispatcher.dispatch('track x')
  assert.deepEqual(reply, { cmd: 'track', ok: false, error: 'boom' })
  assert.equal(terminate, false)
})

test('every command answers exactly once', async () => {
  const dispatcher = createDispatcher(fakeSdk())
  const lines = [
    'init prd_conform001 mac',
    'track x',
    'track x {"a":1}',
    'onboarding tour skip',
    'setprops {"license":"trial"}',
    'installid',
    'dumpstate',
    'reset',
    'disable',
    'sleep 0',
    'nonsense',
  ]
  for (const line of lines) {
    const { reply } = await dispatcher.dispatch(line)
    assert.equal(typeof reply.cmd, 'string')
    assert.equal(typeof reply.ok, 'boolean')
  }
})
