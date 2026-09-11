// The clock arithmetic C15b and C3 turn on.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayIndex, floorDiv, low48, millisUntil, parseInstant } from './instant.ts'

test('parseInstant accepts C15b’s two instants and rejects everything else', () => {
  assert.equal(parseInstant('99999999999999999999'), 99999999999999999999n)
  assert.equal(parseInstant('-14256000000'), -14256000000n)
  assert.equal(parseInstant('0'), 0n) // JELTO_NOW=0 is a PIN, not "unset"
  assert.equal(parseInstant('  1788134400000  '), 1788134400000n)
  assert.equal(parseInstant('+7'), 7n)
  assert.equal(parseInstant(''), null)
  assert.equal(parseInstant('1.5'), null)
  assert.equal(parseInstant('soon'), null)
  assert.equal(parseInstant('1e12'), null)
})

test('the day index floors, so a pre-epoch clock is not folded onto 1970', () => {
  assert.equal(floorDiv(-1n, 86_400_000n), -1n)
  assert.equal(dayIndex(0n), 0n)
  assert.equal(dayIndex(86_399_999n), 0n)
  assert.equal(dayIndex(86_400_000n), 1n)
  // C3: 1788134400000 and 1788220800000 are consecutive UTC days.
  assert.equal(dayIndex(1788134400000n), 20696n)
  assert.equal(dayIndex(1788220800000n), 20697n)
  // C15b's 1969-07-20 is a day of its own, and it is negative.
  assert.equal(dayIndex(-14256000000n), -165n)
  assert.equal(dayIndex(-1n), -1n)
})

test('low48 is Euclidean, so a pre-epoch instant still makes a well-formed v7', () => {
  const modulus = 1n << 48n
  assert.equal(low48(0n), 0n)
  assert.equal(low48(-1n), modulus - 1n)
  assert.ok(low48(-14256000000n) >= 0n && low48(-14256000000n) < modulus)
  assert.ok(low48(99999999999999999999n) >= 0n && low48(99999999999999999999n) < modulus)
})

test('millisUntil saturates rather than wrapping, and never goes negative', () => {
  assert.equal(millisUntil(10n, 20n), 10)
  assert.equal(millisUntil(20n, 10n), 0)
  assert.equal(millisUntil(0n, 99999999999999999999n), 2_147_483_647)
})
