import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from './tokenize.ts'
import { parseProps } from './props.ts'

function propsOf(line: string, at: number): Record<string, unknown> | undefined {
  const parsed = parseProps(tokenize(line), at)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error)
  return parsed.ok ? parsed.props : undefined
}

test('a track carries the object the scenario wrote', () => {
  assert.deepEqual(propsOf('track onboarding:permissions {"status":"ok"}', 2), { status: 'ok' })
  assert.deepEqual(propsOf('track e.custom_0:x {"page":"p","n":1.5,"ok":true}', 2), {
    page: 'p',
    n: 1.5,
    ok: true,
  })
})

test('a setprops carries the object at token 1', () => {
  assert.deepEqual(propsOf('setprops {"license":"paid","edition":"pro"}', 1), {
    license: 'paid',
    edition: 'pro',
  })
  assert.deepEqual(propsOf('setprops {"Email":"x@y.z"}', 1), { Email: 'x@y.z' })
})

test('an absent or blank argument is no props, not an empty object', () => {
  assert.equal(propsOf('track x', 2), undefined)
  assert.equal(propsOf('setprops', 1), undefined)
  // `null` decodes into an absent map in Go too, so it is not a refusal.
  assert.equal(propsOf('setprops null', 1), undefined)
})

test('an empty object is an empty object', () => {
  assert.deepEqual(propsOf('track x {}', 2), {})
})

test('nothing about a value is judged here', () => {
  // C19's 21 keys, C22c's over-long value and W3's 200-character prop must all
  // reach the SDK: the debug line it writes when it drops one is what those
  // scenarios assert on.
  const long = 'a'.repeat(200)
  assert.deepEqual(propsOf(`track x {"k":"${long}"}`, 2), { k: long })
  const wide = propsOf(
    'track y {' + Array.from({ length: 21 }, (_, i) => `"k${i + 1}":"a"`).join(',') + '}',
    2,
  )
  assert.equal(Object.keys(wide ?? {}).length, 21)
  assert.deepEqual(propsOf('track x {"Bad Key!":"v"}', 2), { 'Bad Key!': 'v' })
})

test('a token that is not a JSON object is refused', () => {
  for (const line of ['track x {not json}', 'setprops {"a":}', 'setprops [1,2,3]']) {
    const parsed = parseProps(tokenize(line), line.startsWith('track') ? 2 : 1)
    assert.equal(parsed.ok, false, `expected a refusal for ${line}`)
    if (!parsed.ok) {
      assert.match(parsed.error, /props must be a JSON object/)
    }
  }
})

test('a value with no representation in the §8.1 surface is skipped, not refused', () => {
  // RFC-0001 §8.1's dictionary takes a string, a number or a boolean; there is
  // no call the host could make that carries a null, an object or an array.
  assert.deepEqual(propsOf('track x {"a":"s","b":null,"c":{"d":1},"e":[1]}', 2), { a: 's' })
})
