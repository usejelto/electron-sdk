// Use command strings from the scenario corpus to verify host token boundaries.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from './tokenize.ts'

test('the scenario corpus, verbatim', () => {
  // C2, C5, C7 ...
  assert.deepEqual(tokenize('init prd_conform001'), ['init', 'prd_conform001'])
  // C21: init with a slug
  assert.deepEqual(tokenize('init prd_conform001 mac'), ['init', 'prd_conform001', 'mac'])

  // W2: a quoted name with a space and a bang in it
  assert.deepEqual(tokenize('track "Bad Name!"'), ['track', 'Bad Name!'])
  assert.deepEqual(tokenize('track good_name'), ['track', 'good_name'])
  assert.deepEqual(tokenize('track x'), ['track', 'x'])
  assert.deepEqual(tokenize('track z'), ['track', 'z'])

  // C20b: a quoted free-text reason as the fourth token
  assert.deepEqual(tokenize('onboarding x ok "Free text reason"'), [
    'onboarding',
    'x',
    'ok',
    'Free text reason',
  ])
  assert.deepEqual(tokenize('onboarding "Bad Step!" ok'), ['onboarding', 'Bad Step!', 'ok'])
  assert.deepEqual(tokenize('onboarding driver fail no_kext'), [
    'onboarding',
    'driver',
    'fail',
    'no_kext',
  ])
  assert.deepEqual(tokenize('onboarding permissions ok'), ['onboarding', 'permissions', 'ok'])
  assert.deepEqual(tokenize('onboarding tour skip'), ['onboarding', 'tour', 'skip'])

  // C22, C22b, C22c: a JSON object is ONE token, commas and all
  assert.deepEqual(tokenize('setprops {"license":"paid","edition":"pro"}'), [
    'setprops',
    '{"license":"paid","edition":"pro"}',
  ])
  assert.deepEqual(tokenize('setprops {"Email":"x@y.z"}'), ['setprops', '{"Email":"x@y.z"}'])
  assert.deepEqual(tokenize('setprops {"license":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'), [
    'setprops',
    '{"license":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
  ])

  // W3: props on a track
  assert.deepEqual(tokenize('track onboarding:permissions {"status":"ok"}'), [
    'track',
    'onboarding:permissions',
    '{"status":"ok"}',
  ])
  const long = 'a'.repeat(200)
  assert.deepEqual(tokenize(`track x {"k":"${long}"}`), ['track', 'x', `{"k":"${long}"}`])

  // C19: twenty-one keys, twenty commas, one token
  const wide = '{' + Array.from({ length: 21 }, (_, i) => `"k${i + 1}":"a"`).join(',') + '}'
  assert.deepEqual(tokenize(`track y ${wide}`), ['track', 'y', wide])

  // C6, after the runner has substituted `{i}`
  assert.deepEqual(tokenize('track x0'), ['track', 'x0'])
  assert.deepEqual(
    tokenize('track e.custom_0:x {"page":"' + 'a'.repeat(80) + '","n":1.5,"ok":true}'),
    ['track', 'e.custom_0:x', '{"page":"' + 'a'.repeat(80) + '","n":1.5,"ok":true}'],
  )

  assert.deepEqual(tokenize('sleep 25200000'), ['sleep', '25200000'])
  assert.deepEqual(tokenize('installid'), ['installid'])
  assert.deepEqual(tokenize('dumpstate'), ['dumpstate'])
  assert.deepEqual(tokenize('disable'), ['disable'])
  assert.deepEqual(tokenize('exit'), ['exit'])
})

test('an unsubstituted {i} is not a JSON opener', () => {
  // The `{` is not at the start of the token, so rule 3 does not apply and the
  // token runs to the next space.
  assert.deepEqual(tokenize('track x{i}'), ['track', 'x{i}'])
})

test('a token opening { or [ takes the rest of the line', () => {
  assert.deepEqual(tokenize('track x {"a":1} trailing words'), [
    'track',
    'x',
    '{"a":1} trailing words',
  ])
  assert.deepEqual(tokenize('setprops [1, 2, 3]'), ['setprops', '[1, 2, 3]'])
  // ... and it is trimmed
  assert.deepEqual(tokenize('setprops {"a":1}   '), ['setprops', '{"a":1}'])
})

test('quotes group, and a backslash escapes the next character', () => {
  assert.deepEqual(tokenize('track "a b"'), ['track', 'a b'])
  assert.deepEqual(tokenize('track "say \\"hi\\""'), ['track', 'say "hi"'])
  assert.deepEqual(tokenize('track "back\\\\slash"'), ['track', 'back\\slash'])
  // An unterminated quote takes what is left of the line, as refhost does.
  assert.deepEqual(tokenize('track "unterminated'), ['track', 'unterminated'])
  // An empty quoted token is a token.
  assert.deepEqual(tokenize('track ""'), ['track', ''])
})

test('runs of spaces and tabs separate, and never appear in a token', () => {
  assert.deepEqual(tokenize('init   prd_conform001\t\tmac'), ['init', 'prd_conform001', 'mac'])
  assert.deepEqual(tokenize('   init prd_conform001   '), ['init', 'prd_conform001'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('    '), [])
})

test('non-ASCII survives a token boundary intact', () => {
  assert.deepEqual(tokenize('track "héllo wörld"'), ['track', 'héllo wörld'])
  assert.deepEqual(tokenize('track 🙂'), ['track', '🙂'])
  assert.deepEqual(tokenize('setprops {"k":"héllo 🙂"}'), ['setprops', '{"k":"héllo 🙂"}'])
})
