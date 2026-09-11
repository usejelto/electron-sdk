// spec/wire-v1.md §2, §3, §4, §5.2, §6, §8 — the bytes that may leave, and
// what an answer is read for.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Debug } from './debug.ts'
import {
  buildEnvelope,
  encodeEvent,
  gateAppSlug,
  gateClientVersion,
  gateEventName,
  gateInstallProps,
  gateOnboarding,
  gateTrackProps,
  MAX_BODY_BYTES,
  parseResponse,
  SDK_CLIENT_VERSION,
  withinPropCap,
  type EncodeContext,
} from './wire.ts'

function sink(): { log: Debug; lines(): string } {
  let text = ''
  const stream = { write: (chunk: string | Buffer): boolean => ((text += chunk.toString()), true) }
  return { log: new Debug(stream as unknown as NodeJS.WritableStream, true), lines: () => text }
}

const ctx: EncodeContext = {
  installID: '9f2c0f1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  av: '1.0.0',
  os: 'macos',
  osv: '15.1',
  arch: 'arm64',
  slug: null,
  clientVersion: SDK_CLIENT_VERSION,
  installProps: {},
}

test('C15b: both instants reach the body bytes as bare JSON number literals', () => {
  for (const literal of ['99999999999999999999', '-14256000000', '0', '2103753600000']) {
    const event = encodeEvent({ id: ctx.installID, n: 'heartbeat', t: literal, hb: true }, ctx)
    assert.ok(event !== null)
    const { body, used } = buildEnvelope('prd_conform001', [event])
    assert.equal(used, 1)
    const bytes = body.toString('utf8')
    // The digits, unquoted, exactly as the clock holds them. A `number` would
    // render 99999999999999999999 as 100000000000000000000 (RFC-0001 §8.5).
    assert.ok(bytes.includes(`"t":${literal},`), bytes)
    assert.ok(!bytes.includes(`"t":"${literal}"`))
    // And a JSON reader that is not a float64 gets the same digits back.
    assert.equal(/"t":(-?[0-9]+)/.exec(bytes)?.[1], literal)
  }
  // The trap itself, stated as a test so nobody "simplifies" the encoder.
  assert.equal(
    JSON.stringify({ t: Number('99999999999999999999') }),
    '{"t":100000000000000000000}',
  )
})

test('the event carries exactly §5.2’s app fields, in a fixed order', () => {
  const event = encodeEvent({ id: 'id-1', n: 'x', t: '5' }, { ...ctx, slug: 'mac', clientVersion: 'electron/1.0.0' })
  assert.equal(
    event,
    '{"id":"id-1","n":"x","t":5,"s":"app","iid":"9f2c0f1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",' +
      '"av":"1.0.0","os":"macos","osv":"15.1","arch":"arm64","a":"mac","v":"electron/1.0.0"}',
  )
})

test('C21: no slug argument means no `a` field at all — never an empty one', () => {
  const event = encodeEvent({ id: 'id-1', n: 'heartbeat', t: '5', hb: true }, ctx)
  assert.ok(event !== null)
  assert.ok(!event.includes('"a":'))
})

test('W4: `v` is omitted rather than sent outside the grammar', () => {
  const omitted = encodeEvent({ id: 'id-1', n: 'x', t: '5' }, { ...ctx, clientVersion: null })
  assert.ok(omitted !== null)
  assert.ok(!omitted.includes('"v":'))
  const s = sink()
  assert.equal(gateClientVersion(undefined, s.log), SDK_CLIENT_VERSION)
  assert.equal(gateClientVersion('', s.log), null) // an empty v is an absent v — silently
  assert.equal(s.lines(), '')
  assert.equal(gateClientVersion('1.2.0', s.log), null)
  assert.equal(gateClientVersion('Electron/1.0', s.log), null)
  assert.equal(gateClientVersion('electron/1.0.3', s.log), 'electron/1.0.3')
  assert.equal(gateClientVersion('refhost/0.1.0+conformance', s.log), 'refhost/0.1.0+conformance')
  assert.equal(gateClientVersion(`electron/${'a'.repeat(25)}`, s.log), null) // {1,24}
  assert.ok(SDK_CLIENT_VERSION.match(/^[a-z]+\/[0-9A-Za-z.+-]{1,24}$/))
})

test('a heartbeat carries the install properties current AT SEND, sorted', () => {
  const event = encodeEvent(
    { id: 'id-1', n: 'heartbeat', t: '5', hb: true },
    { ...ctx, installProps: { license: 'paid', edition: 'pro' } },
  )
  assert.ok(event !== null)
  assert.ok(event.endsWith('"props":{"edition":"pro","license":"paid"}}'))
  // An empty map produces no `props` key at all, never `{}` (C22c).
  const bare = encodeEvent({ id: 'id-1', n: 'heartbeat', t: '5', hb: true }, ctx)
  assert.ok(bare !== null && !bare.includes('"props"'))
})

test('C20: the helper’s event and the track it is sugar for encode identically', () => {
  const s = sink()
  const gated = gateOnboarding('permissions', 'ok', undefined, s.log)
  assert.deepEqual(gated, { name: 'onboarding:permissions', props: { status: 'ok' } })
  const helper = encodeEvent({ id: 'a', n: gated!.name, t: '5', props: gated!.props }, ctx)
  const plain = encodeEvent({ id: 'a', n: 'onboarding:permissions', t: '5', props: { status: 'ok' } }, ctx)
  assert.equal(helper, plain)
})

test('§2: the envelope caps at 100 events and 65 536 bytes, on a PREFIX', () => {
  const one = encodeEvent({ id: 'id-1', n: 'x', t: '5' }, ctx)!
  const many = new Array(250).fill(one)
  const { used } = buildEnvelope('prd_conform001', many)
  assert.equal(used, 100)

  const fat = encodeEvent(
    { id: 'id-1', n: 'x', t: '5', props: { k1: 'a'.repeat(200), k2: 'b'.repeat(200), k3: 'c'.repeat(200) } },
    ctx,
  )!
  const heavy = buildEnvelope('prd_conform001', new Array(100).fill(fat))
  assert.ok(heavy.body.byteLength <= MAX_BODY_BYTES, String(heavy.body.byteLength))
  assert.ok(heavy.used < 100)
  // Exactly the prefix it says it took.
  const parsed = JSON.parse(heavy.body.toString('utf8')) as { e: unknown[] }
  assert.equal(parsed.e.length, heavy.used)
  // Nothing fits at all -> used 0, and the caller must not POST an empty body.
  assert.equal(buildEnvelope('prd_conform001', []).used, 0)
})

test('W2: an event name outside §3’s grammar never reaches the wire', () => {
  const s = sink()
  assert.equal(gateEventName('Bad Name!', s.log), null)
  assert.equal(gateEventName('good_name', s.log), 'good_name')
  assert.equal(gateEventName('onboarding:permissions', s.log), 'onboarding:permissions')
  assert.equal(gateEventName('', s.log), null)
  assert.equal(gateEventName('a'.repeat(65), s.log), null)
  assert.equal(gateEventName('a'.repeat(64), s.log), 'a'.repeat(64))
  // JavaScript's `$` does not match before a trailing newline, unlike ICU's.
  assert.equal(gateEventName('good_name\n', s.log), null)
})

test('W3: a 201-character value and a twenty-first key are both refused', () => {
  const s = sink()
  assert.equal(gateTrackProps({ k: 'a'.repeat(201) }, 'x', s.log), false)
  assert.equal(gateTrackProps({ k: 'a'.repeat(200) }, 'x', s.log), true)
  const twentyOne: Record<string, string> = {}
  for (let i = 1; i <= 21; i += 1) twentyOne[`k${i}`] = 'a'
  assert.equal(gateTrackProps(twentyOne, 'y', s.log), false)
  delete twentyOne['k21']
  assert.equal(gateTrackProps(twentyOne, 'y', s.log), true)
  assert.equal(gateTrackProps({ Email: 'x' }, 'y', s.log), false)
  assert.equal(gateTrackProps({ n: 1.5, ok: true, page: 'a' }, 'y', s.log), true)
  assert.equal(gateTrackProps({ n: Number.NaN }, 'y', s.log), false)
  assert.equal(gateTrackProps(undefined, 'y', s.log), true)
})

test('C20b: a bad step and a free-text reason are dropped client-side', () => {
  const s = sink()
  assert.equal(gateOnboarding('Bad Step!', 'ok', undefined, s.log), null)
  assert.equal(gateOnboarding('x', 'ok', 'Free text reason', s.log), null)
  assert.equal(gateOnboarding('x', 'nope', undefined, s.log), null)
  assert.equal(gateOnboarding('driver', 'fail', 'no_kext', s.log)?.props['reason'], 'no_kext')
  assert.equal(gateOnboarding('x', 'ok', 'a'.repeat(65), s.log), null)
})

test('C22c: an install property outside §4’s grammar is dropped, key and value', () => {
  const s = sink()
  assert.deepEqual(gateInstallProps({ Email: 'x@y.z' }, s.log), {})
  assert.deepEqual(gateInstallProps({ license: 'a'.repeat(30) }, s.log), {})
  assert.deepEqual(gateInstallProps({ license: 'paid', edition: 'pro' }, s.log), { license: 'paid', edition: 'pro' })
  assert.deepEqual(gateInstallProps({ license: 5 }, s.log), {}) // §4's grammar is a STRING grammar
  const twentyOne: Record<string, string> = {}
  for (let i = 1; i <= 21; i += 1) twentyOne[`k${i}`] = 'a'
  assert.equal(withinPropCap(twentyOne, s.log), false)
})

test('§5.2: an app slug outside the grammar is dropped, and "" is absent', () => {
  const s = sink()
  assert.equal(gateAppSlug(undefined, s.log), null)
  assert.equal(gateAppSlug('', s.log), null)
  assert.equal(gateAppSlug('mac', s.log), 'mac')
  assert.equal(gateAppSlug('Mac_OS', s.log), null)
})

test('§6/§8: a 202 body is read for `rejected`, `stop` and `error` and nothing else', () => {
  assert.deepEqual(parseResponse(Buffer.from('{}')), { rejected: [], stop: null, error: '' })
  const stopped = parseResponse(
    Buffer.from('{"rejected":[{"i":0,"reason":"stopped"}],"stop":{"until":1788188001,"scope":"app"}}'),
  )
  assert.equal(stopped?.rejected[0]?.reason, 'stopped')
  assert.equal(stopped?.stop?.untilSeconds, 1788188001n)
  assert.equal(stopped?.stop?.scope, 'app')
  assert.equal(parseResponse(Buffer.from('{"error":"payment_required"}'))?.error, 'payment_required')
  // C10's invalid JSON is a swallowed failure, never a retry.
  assert.equal(parseResponse(Buffer.from('not json at all')), null)
  assert.equal(parseResponse(Buffer.from('[]')), null)
  // `until`'s digits come off the RAW TEXT, so a value past 2^53 is exact.
  const huge = parseResponse(Buffer.from('{"stop":{"until":9007199254740993,"scope":"app"}}'))
  assert.equal(huge?.stop?.untilSeconds, 9007199254740993n)
})
