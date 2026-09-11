// Parse command syntax, call the SDK, and report its result. Property legality,
// retries, and state belong to the SDK, not the host (conformance §3.2).

import { tokenize } from './tokenize.ts'
import { parseProps, type PropValue } from './props.ts'
import type { Reply } from './reply.ts'

export type { PropValue }

/**
 * What the host needs of the SDK. It is a structural subset of the
 * `ConformanceSdk` that `sdk/electron/src/index.ts` exports, declared here so
 * that this module -- and its tests -- do not depend on the SDK half of the
 * package; `main.ts` is where the two are joined, and `tsc -p
 * tsconfig.host.json` is what checks that the real one still satisfies it.
 *
 * `exportState` returns `unknown` deliberately. §3.2 lets the host "re-encode
 * what the SDK already holds" and nothing else, so the host is better off not
 * knowing the shape: it cannot then complete, default or repair it.
 */
export interface HostSdk {
  init(key: string, app?: string): void
  track(name: string, props?: Record<string, PropValue>): void
  onboarding(step: string, status: string, reason?: string): void
  setProps(props: Record<string, PropValue>): void
  installId(): string
  reset(): void
  disable(): void
  legacyVersion(): boolean
  exportState(): unknown
  advance(ms: number): Promise<void>
  stop(): Promise<void>
}

export interface DispatchResult {
  reply: Reply
  /** true when the process must now end: `exit` alone sets it. */
  terminate: boolean
}

export interface Dispatcher {
  dispatch(line: string): Promise<DispatchResult>
  /** `exit`'s summary, exposed for the EOF path in main.ts. */
  summary(cmd: string): Reply
}

export interface DispatcherOptions {
  /** Monotonic nanoseconds. Injectable so a test can assert on `us`. */
  nowNs?: () => bigint
  /** Bytes of heap in use. */
  heapUsed?: () => number
}

const USAGE_UNKNOWN =
  'unknown command; spec/sdk-conformance.md §3 has init, track, onboarding, setprops, installid, dumpstate, reset, disable, sleep, exit'

export function createDispatcher(sdk: HostSdk, options: DispatcherOptions = {}): Dispatcher {
  const nowNs = options.nowNs ?? (() => process.hrtime.bigint())
  const heapUsed = options.heapUsed ?? (() => process.memoryUsage().heapUsed)

  const trackTimes: number[] = []
  const heapBefore = heapUsed()

  function summary(cmd: string): Reply {
    const reply: Reply = { cmd, ok: true }
    reply.tracks = trackTimes.length
    reply.heap_delta_kib = Math.trunc((heapUsed() - heapBefore) / 1024)
    if (trackTimes.length > 0) {
      const sorted = [...trackTimes].sort((a, b) => a - b)
      reply.track_p50_us = sorted[Math.floor((sorted.length * 50) / 100)] ?? 0
      reply.track_p99_us =
        sorted[Math.min(Math.floor((sorted.length * 99) / 100), sorted.length - 1)] ?? 0
    }
    return reply
  }

  async function dispatch(line: string): Promise<DispatchResult> {
    const tokens = tokenize(line)
    const cmd = tokens[0]
    if (cmd === undefined) {
      // Unreachable from main.ts, which skips blank lines before it gets here.
      return { reply: { cmd: '', ok: false, error: USAGE_UNKNOWN }, terminate: false }
    }

    // `exit` owns its own failure handling: the process must end within 1 s of
    // the command (C1) whatever `stop()` did, so it cannot fall into the catch
    // below and leave `terminate` false.
    if (cmd === 'exit') {
      let error: string | undefined
      try {
        await sdk.stop()
      } catch (err) {
        error = messageOf(err)
      }
      const reply = summary('exit')
      if (error !== undefined) {
        reply.ok = false
        reply.error = error
      }
      return { reply, terminate: true }
    }

    try {
      return { reply: await run(cmd, tokens), terminate: false }
    } catch (err) {
      // RFC-0001 §8.3 item 10 says the SDK never throws into the host, so
      // reaching here is a finding. It is reported on the reply -- where the
      // runner prints it and fails the arm -- and NOT on stderr, which C10
      // asserts is byte-empty without JELTO_DEBUG.
      return { reply: { cmd, ok: false, error: messageOf(err) }, terminate: false }
    }
  }

  async function run(cmd: string, tokens: string[]): Promise<Reply> {
    switch (cmd) {
      case 'init': {
        const key = tokens[1]
        if (key === undefined) {
          return { cmd, ok: false, error: 'init <key> [app]' }
        }
        const app = tokens[2]
        const started = nowNs()
        sdk.init(key, app)
        // C1's "init returns in < 5 ms (host measures)". Truncated to whole
        // microseconds as refhost's `time.Since(...).Microseconds()` is.
        const us = Number((nowNs() - started) / 1000n)
        return { cmd, ok: true, us }
      }

      case 'track': {
        const name = tokens[1]
        if (name === undefined) {
          return { cmd, ok: false, error: 'track <name> [json-props]' }
        }
        const parsed = parseProps(tokens, 2)
        if (!parsed.ok) {
          return { cmd, ok: false, error: parsed.error }
        }
        const started = nowNs()
        if (parsed.props === undefined) {
          sdk.track(name)
        } else {
          sdk.track(name, parsed.props)
        }
        const us = Number((nowNs() - started) / 1000n)
        trackTimes.push(us)
        return { cmd, ok: true, us }
      }

      case 'onboarding': {
        const step = tokens[1]
        const status = tokens[2]
        if (step === undefined || status === undefined) {
          return { cmd, ok: false, error: 'onboarding <step> <ok|fail|skip> [reason]' }
        }
        // Nothing is validated here. C20b sends a bad step and a bad status on
        // purpose, and the debug lines the SDK writes about them are what that
        // scenario asserts on.
        sdk.onboarding(step, status, tokens[3])
        return { cmd, ok: true }
      }

      case 'setprops': {
        const parsed = parseProps(tokens, 1)
        if (!parsed.ok) {
          return { cmd, ok: false, error: parsed.error }
        }
        if (parsed.props === undefined) {
          return { cmd, ok: false, error: 'setprops <json>' }
        }
        sdk.setProps(parsed.props)
        return { cmd, ok: true }
      }

      case 'installid':
        return { cmd, ok: true, value: sdk.installId() }

      case 'dumpstate':
        // §3.2's export, passed straight through. The host adds nothing to it:
        // "a fact the SDK does not have is absent from the export ... never a
        // plausible value the host supplied."
        return { cmd, ok: true, state: sdk.exportState() }

      case 'reset':
        sdk.reset()
        return { cmd, ok: true }

      case 'legacyversion':
        return sdk.legacyVersion() ? { cmd, ok: true } : { cmd, ok: false, error: 'legacyversion requires initialized state with no pending transition' }

      case 'disable':
        sdk.disable()
        return { cmd, ok: true }

      case 'sleep': {
        const raw = tokens[1]
        if (raw === undefined || !/^\d+$/.test(raw)) {
          return { cmd, ok: false, error: 'sleep <ms>: a whole number >= 0' }
        }
        const ms = Number(raw)
        if (!Number.isSafeInteger(ms)) {
          return { cmd, ok: false, error: 'sleep <ms>: a whole number >= 0' }
        }
        // §3.1's clock is the SDK's, not the host's: pinned, `advance` moves it
        // and settles the work that fell due; unpinned, it really sleeps. Which
        // of the two is the SDK's decision and the host does not ask.
        await sdk.advance(ms)
        return { cmd, ok: true }
      }

      default:
        return { cmd, ok: false, error: USAGE_UNKNOWN }
    }
  }

  return { dispatch, summary }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
