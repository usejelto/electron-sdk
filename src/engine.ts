// One pump owns deadlines and requests, processing one action per iteration so
// clock advances fire all due work in order.
//
// Node cannot block waiting for asynchronous bootstrap. init schedules it with
// setImmediate; a synchronous public call that arrives first runs it eagerly.
// This keeps bootstrap out of init while installId/exportState can return current state.

import {
  BACKOFF_CEILING_MS,
  headerNote,
  JITTER_HIGH,
  JITTER_LOW,
  nextBackoff,
} from './backoff.ts'
import { Clock } from './clock.ts'
import { Debug } from './debug.ts'
import { resolveEndpoint } from './endpoint.ts'
import { millisUntil, parseInstant } from './instant.ts'
import { detectPlatform, knownAppVersion, type Platform } from './platform.ts'
import { EventQueue } from './queue.ts'
import { Store } from './store.ts'
import { Transport, type Outcome } from './transport.ts'
import { NIL_UUID, uuidV4, uuidV7 } from './uuid.ts'
import {
  buildEnvelope,
  encodeEvent,
  gateAppSlug,
  gateClientVersion,
  gateEventName,
  gateInstallProps,
  gateOnboarding,
  gateTrackProps,
  MAX_EVENTS_PER_REQUEST,
  parseResponse,
  withinPropCap,
  type EncodeContext,
  type PropValue,
  type QueuedEvent,
} from './wire.ts'

/** RFC-0001 §8.3 item 7, "2 s after init". */
export const INIT_FLUSH_DELAY_MS = 2_000
/** RFC-0001 §8.3 item 7, "5 s debounce after track". */
export const TRACK_DEBOUNCE_MS = 5_000
/** RFC-0001 §8.2 item 4, "a random delay of 0-6 h". */
export const INSTALL_MAX_DELAY_MS = 6 * 60 * 60 * 1000
/** RFC-0001 §8.2 item 4, "or after 30 days of attempts". */
export const INSTALL_CLAIM_AFTER_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Bounds §8.3 item 7's "on app background/termination (best effort)". C1 gives
 * the process 1 s to exit with 1 000 events queued, so the flush cannot be
 * unbounded.
 */
export const TERMINATION_BUDGET_MS = 600
/** One `advance` in REAL time, however many barriers it takes. */
export const SETTLE_BUDGET_MS = 30_000

/** spec/sdk-conformance.md §3.2's export, key for key. Instants are DECIMAL STRINGS. */
export interface StateExport {
  install_id: string
  last_app_version?: string
  last_heartbeat_day?: string
  install_claimed: boolean
  install_due_at?: string
  install_first_try?: string
  install_props?: Record<string, string>
  backoff_step_ms?: number
  backoff_next_at?: string
  stop_until?: string
  stop_probe_due?: boolean
  queue: { bytes: number; events: Array<{ id: string; n: string; t: string }> }
}

interface StepResult {
  next: bigint | null
  acted: boolean
}

interface AckWaiter {
  seq: number
  resolve(value: boolean): void
}

export interface EngineOptions {
  endpoint: string
  stateDir: string
  clock: Clock
  log: Debug
  stderr: NodeJS.WritableStream
  mock: string | null
  clientVersion: string | null
  env: NodeJS.ProcessEnv
}

export class Engine {
  readonly clockPinned: boolean

  private readonly clock: Clock
  private readonly log: Debug
  private readonly stderr: NodeJS.WritableStream
  private readonly store: Store
  private readonly queue: EventQueue
  private readonly defaultEndpoint: string
  private endpoint: string
  private readonly mock: string | null
  private readonly clientVersion: string | null
  private readonly env: NodeJS.ProcessEnv
  private transport: Transport | null = null

  private started = false
  private disabled = false
  private quit = false
  private booted = false
  private key = ''
  private slug: string | null = null
  private platform: Platform | null = null
  private installIDValue = ''
  private props: Record<string, string> = {}
  private observedAt = 0n
  private observationComplete = false
  private stagedUpdate: QueuedEvent | null = null
  private installEnqueuedThisRun = false

  private initFlushAt: bigint | null = null
  private trackFlushAt: bigint | null = null
  private pending = false

  private pumpActive = false
  private pumpDone: Promise<void> | null = null
  private wakePending = false
  private wakeResolve: (() => void) | null = null

  private idleWant = 0
  private idleAck = 0
  private ackWaiters: AckWaiter[] = []

  constructor(options: EngineOptions) {
    this.clock = options.clock
    this.clockPinned = options.clock.pinned
    this.log = options.log
    this.stderr = options.stderr
    this.store = new Store(options.stateDir)
    this.queue = new EventQueue(options.stateDir, this.store.queuePath)
    this.endpoint = options.endpoint
    this.defaultEndpoint = options.endpoint
    this.mock = options.mock
    this.clientVersion = options.clientVersion
    this.env = options.env
  }


  /**
   * §8.2 item 1: returns immediately, all work on a background path (C1). §8.1:
   * init happens once — except after `disable()`, where §8.7 item 18's
   * "no-ops UNTIL THE NEXT INIT" re-arms it.
   */
  init(key: string, app?: string, endpoint?: string): void {
    if (this.started && !this.disabled) return
    this.endpoint = resolveEndpoint(endpoint, this.defaultEndpoint, this.log)
    this.transport?.close()
    this.transport = null
    const reArm = this.started && this.disabled
    this.started = true
    this.disabled = false
    this.quit = false
    this.key = typeof key === 'string' ? key : String(key)
    this.booted = false
    this.slug = gateAppSlug(app, this.log)
    setImmediate(() => {
      this.ensureBootstrapped()
      if (reArm) this.notify()
      else this.startPump()
    })
  }

  /** §8.1's `track`: queued; a no-op before `init` (C5) and after `disable()` (C18). */
  track(name: string, props?: Record<string, PropValue>): void {
    if (!this.ready()) return
    const gated = gateEventName(name, this.log)
    if (gated === null) return
    if (!gateTrackProps(props, name, this.log)) return
    const now = this.clock.now()
    const event: QueuedEvent = { id: uuidV7(now), n: gated, t: now.toString() }
    if (props !== undefined && props !== null && Object.keys(props).length > 0) event.props = { ...props }
    this.enqueue(event)
    this.trackFlushAt = now + BigInt(TRACK_DEBOUNCE_MS) // §8.3 item 7, reset by every track
    this.notify()
  }

  /**
   * §8.1's sugar. "the helper cannot do anything track cannot", so it validates
   * §4's namespace and then calls exactly the same path — which is what C20's
   * congruence check is looking for.
   */
  onboarding(step: string, status: string, reason?: string): void {
    if (!this.ready()) return
    const gated = gateOnboarding(step, status, reason, this.log)
    if (gated === null) return
    this.track(gated.name, gated.props)
  }

  /** §8.1: "persisted, sent with every heartbeat, an immediate heartbeat on change". */
  setProps(raw: Record<string, PropValue>): void {
    if (!this.ready()) return
    const accepted = gateInstallProps(raw, this.log)
    const merged: Record<string, string> = { ...this.props, ...accepted }
    if (!withinPropCap(merged, this.log)) return
    if (sameProps(merged, this.props)) return // C22b: the same value twice is not a change
    this.store.update((state) => {
      state.install_props = merged
    })
    this.props = merged
    const now = this.clock.now()
    this.enqueue({ id: uuidV7(now), n: 'heartbeat', t: now.toString(), hb: true })
    this.pending = true // "an immediate heartbeat on change" (C22's <= 2 s)
    this.notify()
  }

  /** §8.1's `installId`. Empty before `init` and after `disable()` (C18). */
  installId(): string {
    if (!this.ready()) return ''
    return this.installIDValue
  }

  /**
   * §8.1's "rotate". NO RULE names what else it rotates — §8.1 says only "view,
   * rotate, wipe (queue + id)" and no C-scenario exercises it. Follows refhost:
   * a new id is a new install, so the claim and the heartbeat day go with it.
   */
  reset(): void {
    if (!this.ready()) return
    const now = this.clock.now()
    const id = uuidV4()
    if (!this.queue.discardUpdates()) return
    if (!this.store.commit((state) => {
      delete state.pending_update
      state.last_app_version = this.platform?.observedVersion ?? ''
      state.install_id = id
      state.install_claimed = false
      state.install_due_at = (now + BigInt(randomInstallDelay())).toString()
      state.install_first_try = ''
      state.last_heartbeat_day = ''
    })) return
    this.stagedUpdate = null
    this.observationComplete = true
    this.installEnqueuedThisRun = this.queue.contains('install')
    this.installIDValue = id
    this.notify()
  }

  /** §8.7 item 18: delete the queue and the install_id; no-ops until the next init. */
  disable(): void {
    if (!this.ready()) return
    this.disabled = true
    this.installIDValue = ''
    this.props = {}
    this.stagedUpdate = null
    this.observationComplete = false
    this.installEnqueuedThisRun = false
    this.initFlushAt = null
    this.trackFlushAt = null
    this.pending = false
    this.queue.delete()
    this.store.wipe()
    this.notify()
  }


  /**
   * A read and only a read: before `init` this creates nothing, loads nothing
   * and writes nothing, so C5's `dumpstate` leaves JELTO_STATE_DIR as empty as
   * it found it. After `init` it forces the bootstrap `init` already started,
   * which is what refhost's `<-ready` and Swift's `waitReady()` do.
   */
  exportState(): StateExport {
    if (this.started && !this.disabled) this.ensureBootstrapped()
    const state = this.store.get()
    const output: StateExport = {
      install_id: state.install_id,
      install_claimed: state.install_claimed,
      queue: { bytes: this.queue.byteCount, events: this.queue.exported() },
    }
    if (state.last_heartbeat_day !== '') output.last_heartbeat_day = state.last_heartbeat_day
    if (state.last_app_version !== '') output.last_app_version = state.last_app_version
    if (state.install_due_at !== '') output.install_due_at = state.install_due_at
    if (state.install_first_try !== '') output.install_first_try = state.install_first_try
    if (Object.keys(state.install_props).length > 0) output.install_props = { ...state.install_props }
    if (state.backoff_step_ms !== 0) output.backoff_step_ms = state.backoff_step_ms
    if (state.backoff_next_at !== '') output.backoff_next_at = state.backoff_next_at
    if (state.stop_until !== '') output.stop_until = state.stop_until
    if (state.stop_probe_due) output.stop_probe_due = true
    return output
  }

  /** Conformance-only migration seam; absent from the customer Jelto interface. */
  legacyVersion(): boolean {
    if (!this.ready() || this.store.get().pending_update !== undefined) return false
    return this.store.commit((state) => { state.last_app_version = '' })
  }


  /**
   * Unpinned: really sleep. C7's "2 s ± 0.5 s", C8's schedule and C22's "<= 2 s"
   * are assertions on mockd's REAL arrival times and cannot be made in a frame
   * mockd cannot see.
   *
   * Pinned: settle, advance, settle. Both settles are load-bearing. Before,
   * because §8.2 item 1 lets `init` return before the pump has read the clock,
   * so advancing without settling first moves the clock out from under
   * bootstrap and anchors init's own 2 s flush late. After, because that is the
   * settle proper: the work that BECAME due at the new time has been dispatched
   * and answered.
   */
  async advance(millis: number): Promise<void> {
    const span = Number.isFinite(millis) ? Math.trunc(millis) : 0
    if (!this.clock.pinned) {
      await realSleep(Math.max(0, span))
      return
    }
    const deadline = Date.now() + SETTLE_BUDGET_MS
    if (!(await this.settle(deadline))) return
    this.clock.advance(BigInt(span))
    await this.settle(deadline)
  }

  /** §8.3 item 7's bounded best-effort termination flush. Leaves no live handles. */
  async stop(): Promise<void> {
    if (!this.started) {
      this.closeTransport()
      return
    }
    if (!this.disabled) this.pending = true
    this.notify()

    const deadline = Date.now() + TERMINATION_BUDGET_MS
    while (this.queue.length > 0 && Date.now() < deadline && !this.sendingGated()) {
      await realSleep(5)
    }
    if (this.queue.length > 0) {
      this.log.log(
        `termination flush gave up with ${this.queue.length} events queued (best effort, RFC-0001 §8.3 item 7)`,
      )
    }

    this.quit = true
    this.notify()
    for (const waiter of this.ackWaiters.splice(0)) waiter.resolve(true)
    // Abandon in-flight requests on exit rather than waiting out the five-second network timeout.
    if (this.pumpDone !== null) await raceTimeout(this.pumpDone, 2_000)
    this.closeTransport()
  }


  /** The gate on every public call: false before `init` and after `disable()`. */
  private ready(): boolean {
    if (!this.started) return false
    if (this.disabled) return false
    this.ensureBootstrapped()
    return !this.disabled
  }

  /** Idempotent, synchronous, and everything `init` would otherwise do inline. */
  private ensureBootstrapped(): void {
    if (this.booted || !this.started || this.disabled) return
    this.booted = true

    this.store.load()
    this.queue.load(this.store.get().pending_update?.id)
    this.installEnqueuedThisRun = this.queue.contains('install')
    this.platform = detectPlatform(this.env, this.log)
    const now = this.clock.now()
    this.observedAt = now
    this.observationComplete = false
    this.stagedUpdate = null

    this.store.update((state) => {
      if (state.install_id === '' || state.install_id === NIL_UUID) state.install_id = uuidV4()
      // Persist the install schedule once so relaunch does not redraw its deadline (C4c).
      if (!state.install_claimed && state.install_due_at === '') {
        state.install_due_at = (now + BigInt(randomInstallDelay())).toString()
      }
    })

    const state = this.store.get()
    this.installIDValue = state.install_id
    this.props = { ...state.install_props }
    this.initFlushAt = now + BigInt(INIT_FLUSH_DELAY_MS) // §8.3 item 7's first trigger
    this.observeAppVersion()

    const day = this.clock.dayIndex()
    if (state.last_heartbeat_day !== day) {
      this.store.update((next) => {
        next.last_heartbeat_day = day
      })
      this.enqueue({ id: uuidV7(now), n: 'heartbeat', t: now.toString(), hb: true })
    }
  }

  private enqueue(event: QueuedEvent): void {
    if (event.metadata === undefined) event.metadata = this.eventMetadata()
    const dropped = this.queue.append(event)
    if (dropped > 0) {
      this.log.log(`queue cap reached: dropped ${dropped} oldest event(s) (RFC-0001 §8.3 item 6)`)
    }
    this.notify()
  }

  private eventMetadata(): QueuedEvent['metadata'] {
    if (this.platform === null) return undefined
    const { av, os, osv, arch } = this.platform
    return { av, os, osv, arch, slug: this.slug, clientVersion: this.clientVersion }
  }

  /** Baseline and intent commit together; dispatch waits for durable queue handoff. */
  private observeAppVersion(): boolean {
    if (this.observationComplete) return true
    const pending = this.store.get().pending_update
    if (pending !== undefined) {
      if (!this.queue.recover(pending)) return false
      if (!this.store.commit((state) => { delete state.pending_update })) return false
    }
    const current = this.platform?.observedVersion
    const previous = this.store.get().last_app_version
    if (current === undefined || current === previous) {
      this.observationComplete = true
      return true
    }
    if (!knownAppVersion(previous)) {
      if (!this.store.commit((state) => { state.last_app_version = current })) return false
      this.observationComplete = true
      return true
    }
    this.stagedUpdate ??= {
      id: uuidV7(this.observedAt), n: 'app_updated', t: this.observedAt.toString(),
      props: { from_version: previous, to_version: current },
      metadata: { ...this.eventMetadata()!, av: current, installID: this.installIDValue },
    }
    const event = this.stagedUpdate
    if (!this.store.commit((state) => {
      state.last_app_version = current
      state.pending_update = event
    })) return false
    this.stagedUpdate = null
    return this.observeAppVersion()
  }


  private startPump(): void {
    if (this.pumpActive) return
    this.pumpActive = true
    this.pumpDone = this.pumpLoop().catch(() => undefined)
  }

  private async pumpLoop(): Promise<void> {
    for (;;) {
      if (this.quit) {
        this.pumpActive = false
        return
      }
      // Clear before reading the barrier and clock so a concurrent notify schedules a fresh observation.
      this.wakePending = false
      const barrier = this.idleWant
      const now = this.clock.now()
      const result = await this.step(now)
      if (result.acted) continue
      if (this.booted) this.ackBarrier(barrier)
      if (this.wakePending || this.quit) continue
      await this.park(result.next, now)
    }
  }

  private park(next: bigint | null, now: bigint): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        this.wakeResolve = null
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      this.wakeResolve = finish
      if (!this.clock.pinned && next !== null) {
        timer = setTimeout(finish, millisUntil(now, next))
        timer.unref()
      }
    })
  }

  private notify(): void {
    this.wakePending = true
    const wake = this.wakeResolve
    if (wake !== null) wake()
  }

  /** At most one due action, in this order, and the next deadline. */
  private async step(now: bigint): Promise<StepResult> {
    if (!this.started || this.disabled) return { next: null, acted: false }
    if (!this.observeAppVersion()) return { next: now + 1000n, acted: false }
    const state = this.store.get()

    const firstTry = parseInstant(state.install_first_try)
    if (!state.install_claimed && firstTry !== null && now >= firstTry + BigInt(INSTALL_CLAIM_AFTER_MS)) {
      this.store.update((next) => {
        next.install_claimed = true
      })
      this.log.log('install claimed after 30 days of attempts without a 202 (RFC-0001 §8.2 item 4)')
      return { next: null, acted: true }
    }

    // A queued install is already the retry; never enqueue a second copy (C4b).
    const dueAt = parseInstant(state.install_due_at)
    if (!state.install_claimed && !this.installEnqueuedThisRun && dueAt !== null && now >= dueAt && !this.queue.contains('install')) {
      this.store.update((next) => {
        if (next.install_first_try === '') next.install_first_try = now.toString()
      })
      this.installEnqueuedThisRun = true
      this.enqueue({ id: uuidV7(now), n: 'install', t: now.toString() })
      this.pending = true
      return { next: null, acted: true }
    }

    const stopUntil = parseInstant(state.stop_until)
    if (stopUntil !== null && now < stopUntil) return { next: this.nextDeadline(now), acted: false }
    if (stopUntil !== null) {
      this.store.update((next) => {
        next.stop_until = ''
      })
      this.log.log('kill switch elapsed (spec/wire-v1.md §8)')
      return { next: null, acted: true }
    }

    // The retry gate also governs failed stop probes.
    const retryAt = parseInstant(state.backoff_next_at)
    if (retryAt !== null && now < retryAt) return { next: this.nextDeadline(now), acted: false }

    // After a stop, send one heartbeat alone and await its response before draining the queue (wire §8).
    if (state.stop_probe_due) {
      await this.sendProbe(now)
      return { next: null, acted: true }
    }

    if (this.initFlushAt !== null && now >= this.initFlushAt) {
      this.initFlushAt = null
      this.pending = true
    }
    if (this.trackFlushAt !== null && now >= this.trackFlushAt) {
      this.trackFlushAt = null
      this.pending = true
    }

    if (this.pending && this.queue.length > 0) {
      await this.sendBatch(now)
      return { next: null, acted: true }
    }
    if (this.pending) this.pending = false
    return { next: this.nextDeadline(now), acted: false }
  }

  /** The earliest instant STRICTLY AFTER `now` that the pump has to wake for. */
  private nextDeadline(now: bigint): bigint | null {
    const state = this.store.get()
    const candidates: Array<bigint | null> = [
      this.initFlushAt,
      this.trackFlushAt,
      parseInstant(state.backoff_next_at),
      parseInstant(state.stop_until),
    ]
    if (!state.install_claimed) {
      if (!this.installEnqueuedThisRun) candidates.push(parseInstant(state.install_due_at))
      const firstTry = parseInstant(state.install_first_try)
      if (firstTry !== null) candidates.push(firstTry + BigInt(INSTALL_CLAIM_AFTER_MS))
    }
    let best: bigint | null = null
    for (const candidate of candidates) {
      if (candidate === null || candidate <= now) continue
      if (best === null || candidate < best) best = candidate
    }
    return best
  }

  private sendingGated(): boolean {
    const state = this.store.get()
    const now = this.clock.now()
    const stopUntil = parseInstant(state.stop_until)
    if (stopUntil !== null && now < stopUntil) return true
    const retryAt = parseInstant(state.backoff_next_at)
    return retryAt !== null && now < retryAt
  }


  private encodeContext(): EncodeContext | null {
    const platform = this.platform
    if (platform === null) return null // no legal §5.2 os/arch: nothing may be sent
    return {
      installID: this.installIDValue,
      av: platform.av,
      os: platform.os,
      osv: platform.osv,
      arch: platform.arch,
      slug: this.slug,
      clientVersion: this.clientVersion,
      installProps: this.props,
    }
  }

  private connection(): Transport {
    if (this.transport === null) this.transport = new Transport(this.endpoint, this.mock)
    return this.transport
  }

  private closeTransport(): void {
    this.transport?.close()
  }

  private async sendBatch(now: bigint): Promise<void> {
    void now
    const ctx = this.encodeContext()
    if (ctx === null) return
    const queued = this.queue.head(MAX_EVENTS_PER_REQUEST)
    const rendered: string[] = []
    for (const event of queued) {
      const encoded = encodeEvent(event, ctx)
      if (encoded === null) break // keep `used` a true PREFIX of the queue
      rendered.push(encoded)
    }
    if (rendered.length === 0) {
      this.queue.remove(1)
      return
    }
    const { body, used } = buildEnvelope(this.key, rendered)
    if (used === 0) {
      this.queue.remove(1)
      return
    }

    this.log.payload(body) // §8.7 item 17: printed BEFORE it is sent (C17)
    const outcome = await this.connection().post(body)
    // Measure Retry-After from response arrival, not request start.
    const answeredAt = this.clock.now()
    if (this.disabled || this.installIDValue !== ctx.installID) return

    if (outcome.retryable) {
      this.applyBackoff(answeredAt, outcome)
      return
    }
    if (outcome.status === 202) {
      this.queue.removeIDs(new Set(queued.slice(0, used).map((event) => event.id)))
      if (queued.slice(0, used).some((event) => event.n === 'install')) {
        this.store.update((state) => {
          state.install_claimed = true // §8.2 item 4: "Mark claimed on 202"
        })
      }
      this.applyAccepted(answeredAt, outcome)
      this.clearBackoff()
      this.pending = this.queue.length > 0
      return
    }
    this.finalRefusal(outcome)
    this.queue.removeIDs(new Set(queued.slice(0, used).map((event) => event.id)))
    this.clearBackoff()
    this.pending = this.queue.length > 0
  }

  /** wire §8's single-heartbeat re-check. Never enters the queue. */
  private async sendProbe(now: bigint): Promise<void> {
    const ctx = this.encodeContext()
    if (ctx === null) {
      this.store.update((state) => {
        state.stop_probe_due = false
      })
      return
    }
    const probe: QueuedEvent = { id: uuidV7(now), n: 'heartbeat', t: now.toString(), hb: true }
    const encoded = encodeEvent(probe, ctx)
    if (encoded === null) {
      this.store.update((state) => {
        state.stop_probe_due = false
      })
      return
    }
    const { body, used } = buildEnvelope(this.key, [encoded])
    if (used !== 1) {
      this.store.update((state) => {
        state.stop_probe_due = false
      })
      return
    }

    this.log.payload(body)
    const outcome = await this.connection().post(body)
    const answeredAt = this.clock.now()
    if (this.disabled || this.installIDValue !== ctx.installID) return

    if (outcome.retryable) {
      // `stop_probe_due` stays true; the retry gate delays it.
      this.applyBackoff(answeredAt, outcome)
      return
    }
    if (outcome.status === 202) {
      this.applyAccepted(answeredAt, outcome)
      this.clearBackoff()
      // Only clear the probe when the switch did not come straight back on: an
      // `until` in the response re-arms it and the next lift owes another probe.
      if (this.store.get().stop_until === '') {
        this.store.update((state) => {
          state.stop_probe_due = false
        })
      }
      return
    }
    this.finalRefusal(outcome)
    this.clearBackoff()
    this.store.update((state) => {
      state.stop_probe_due = false
    })
  }

  /** A 202 body: wire §6's `rejected`, wire §8's `stop`. */
  private applyAccepted(answeredAt: bigint, outcome: Outcome): void {
    const parsed = parseResponse(outcome.body)
    if (parsed === null) {
      // A malformed 202 body does not undo envelope acceptance (C10).
      this.log.log('202 with a body that is not JSON')
      return
    }
    for (const rejection of parsed.rejected) {
      const suffix = rejection.field === '' ? '' : ` (${rejection.field})`
      this.log.log(`event ${rejection.i} rejected: ${rejection.reason}${suffix} (spec/wire-v1.md §6)`)
    }
    const stop = parsed.stop
    if (stop === null) return
    // wire §8: `scope` is app or web. C16b: an app SDK ignores a web-scoped stop.
    if (stop.scope === 'web') {
      this.log.log('ignoring a stop scoped to web (spec/wire-v1.md §8; this client is s=app)')
      return
    }
    if (stop.untilSeconds === null) {
      this.log.log(`ignoring a stop whose \`until\` is not whole seconds: ${Debug.display(stop.untilText)}`)
      return
    }
    // wire §8 sends `until` in SECONDS; §3.2 exports `stop_until` in ms.
    const untilMS = stop.untilSeconds * 1000n
    if (untilMS < answeredAt) {
      // An expired stop still requires the first post-expiry probe. C16 checks this
      // diagnostic to verify that its host and mock clocks are aligned.
      this.log.log(`stop until ${untilMS.toString()} is already past (now ${answeredAt.toString()})`)
    }
    this.store.update((state) => {
      state.stop_until = untilMS.toString()
      state.stop_probe_due = true
    })
    this.log.log(
      `kill switch: no request until ${untilMS.toString()} ms, scope ${stop.scope} (spec/wire-v1.md §8)`,
    )
  }

  private finalRefusal(outcome: Outcome): void {
    const parsed = parseResponse(outcome.body)
    const suffix = parsed !== null && parsed.error !== '' ? ` ${parsed.error}` : ''
    this.log.log(
      `batch dropped: status=${outcome.status}${suffix} -- final, not retried (RFC-0001 §8.3 items 8-9, spec/wire-v1.md §2a)`,
    )
  }

  private applyBackoff(answeredAt: bigint, outcome: Outcome): void {
    if (outcome.error !== null) {
      this.log.log(`request failed: ${outcome.error} (network error, retryable per RFC-0001 §8.3 item 8)`)
    }
    const note = headerNote(outcome.retryAfter)
    if (note !== null) this.log.log(note)

    const before = this.store.get().backoff_step_ms
    const jitter = JITTER_LOW + (JITTER_HIGH - JITTER_LOW) * Math.random()
    const result = nextBackoff(before, outcome.retryAfter, answeredAt, jitter)
    let refusals = 0
    this.store.update((state) => {
      state.backoff_step_ms = Math.min(result.nextStepMS, BACKOFF_CEILING_MS)
      state.backoff_next_at = result.deadline.toString()
      state.backoff_failures += 1
      refusals = state.backoff_failures
    })
    this.log.log(
      `retry in ${result.waitMS} ms (${result.source} governs; step was ${result.governingStepMS} ms, refusal ${refusals}) status=${outcome.status}`,
    )
  }

  private clearBackoff(): void {
    const state = this.store.get()
    if (state.backoff_step_ms === 0 && state.backoff_next_at === '' && state.backoff_failures === 0) return
    this.store.update((next) => {
      next.backoff_step_ms = 0
      next.backoff_next_at = ''
      next.backoff_failures = 0
    })
  }

  // Acknowledge barriers only after observing the advanced clock and finding no due work,
  // including completion of in-flight requests. Quiet polling cannot prove the pump ran
  // (conformance/TODO.md §5).

  private openBarrier(): number {
    this.idleWant += 1
    const seq = this.idleWant
    this.notify()
    return seq
  }

  private ackBarrier(seq: number): void {
    if (seq <= this.idleAck) return
    this.idleAck = seq
    const pending = this.ackWaiters
    this.ackWaiters = []
    for (const waiter of pending) {
      if (this.idleAck >= waiter.seq) waiter.resolve(true)
      else this.ackWaiters.push(waiter)
    }
  }

  private awaitBarrier(seq: number, budgetMS: number): Promise<boolean> {
    if (!this.started || this.quit || this.idleAck >= seq) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const waiter: AckWaiter = {
        seq,
        resolve: (value: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const at = this.ackWaiters.indexOf(waiter)
          if (at >= 0) this.ackWaiters.splice(at, 1)
          resolve(value)
        },
      }
      const timer = setTimeout(() => waiter.resolve(false), Math.max(0, budgetMS))
      this.ackWaiters.push(waiter)
    })
  }

  private async settle(deadlineReal: number): Promise<boolean> {
    if (!this.started || this.quit) return true
    const seq = this.openBarrier()
    if (await this.awaitBarrier(seq, deadlineReal - Date.now())) return true
    // Report a wedged pinned-clock scenario even when SDK debug logging is disabled.
    this.stderr.write('jelto: sleep did not settle within 30 s of real time\n')
    return false
  }
}

function sameProps(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/** RFC-0001 §8.2 item 4: RANDOM, with no seed knob (spec/sdk-conformance.md §3.1). */
function randomInstallDelay(): number {
  return Math.floor(Math.random() * INSTALL_MAX_DELAY_MS)
}

function realSleep(millis: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, millis)
  })
}

function raceTimeout(promise: Promise<void>, millis: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, millis)
    timer.unref()
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

export { gateClientVersion, Clock, Debug }
