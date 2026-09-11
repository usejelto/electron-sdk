// JELTO_NOW presence pins the clock, including 0. Only advance moves a pinned clock.

import { dayIndex } from './instant.ts'

export class Clock {
  readonly pinned: boolean
  private value: bigint

  constructor(pin: bigint | null) {
    this.pinned = pin !== null
    this.value = pin ?? 0n
  }

  /** Client wall-clock milliseconds (spec/wire-v1.md §3's `t`). */
  now(): bigint {
    return this.pinned ? this.value : BigInt(Date.now())
  }

  /** No-op on the real clock: there the caller really sleeps instead. */
  advance(millis: bigint): void {
    if (this.pinned) this.value += millis
  }

  /** spec/sdk-conformance.md §3.2's `last_heartbeat_day`, as a decimal string. */
  dayIndex(): string {
    return dayIndex(this.now()).toString()
  }
}
