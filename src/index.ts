
import { Clock } from './clock.ts'
import { Debug } from './debug.ts'
import { Engine, type StateExport } from './engine.ts'
import { resolveEndpoint } from './endpoint.ts'
import { parseInstant } from './instant.ts'
import { electronApp } from './platform.ts'
import { gateClientVersion, type PropValue } from './wire.ts'

export type { StateExport } from './engine.ts'
export type { PropValue } from './wire.ts'

/** RFC-0001 §8.1's whole public surface. No other public API in v1. */
export interface Jelto {
  /**
   * `endpoint` is for a customer on a first-party subdomain (RFC-0001 §10), who
   * serves `/v1/e` on their own hostname. Omit it and the SDK sends to
   * spec/wire-v1.md §1's production host, which is what every ordinary
   * integration wants: a REQUIRED endpoint is one more thing every integration
   * can get wrong, and getting it wrong is silent.
   */
  init(key: string, app?: string, endpoint?: string): void
  track(name: string, props?: Record<string, PropValue>): void
  onboarding(step: string, status: string, reason?: string): void
  setProps(props: Record<string, PropValue>): void
  installId(): string
  reset(): void
  disable(): void
}

/** What the conformance host needs and a customer never sees. */
export interface ConformanceSdk extends Jelto {
  legacyVersion(): boolean
  /** spec/sdk-conformance.md §3.2's export. MUST create, load and write NOTHING (C5). */
  exportState(): StateExport
  /** true when JELTO_NOW pinned the clock (its PRESENCE is the pin; "0" is a pin). */
  readonly clockPinned: boolean
  /** §3's `sleep <ms>`. Pinned: settle, advance, settle. Unpinned: really sleep. */
  advance(ms: number): Promise<void>
  /** §8.3 item 7's bounded best-effort termination flush; leaves no live handles. */
  stop(): Promise<void>
}

/**
 * Reads spec/sdk-conformance.md §3's six environment variables off `env` and
 * builds an SDK writing debug to `stderr`. Touches no disk and opens no socket
 * (C5): `Engine`'s constructor only records paths, and the `Transport` (and so
 * the HTTP agent) is built on the first send.
 *
 * A malformed `JELTO_NOW` leaves the clock UNPINNED and writes one debug line
 * rather than throwing. The seam names exactly two throwing conditions and this
 * is not one of them; RFC-0001 §8.3 item 10 forbids throwing into the host
 * besides.
 */
export function createSdk(env: NodeJS.ProcessEnv, stderr: NodeJS.WritableStream): ConformanceSdk {
  const endpoint = env['JELTO_ENDPOINT'] ?? ''
  if (endpoint === '') {
    throw new Error('JELTO_ENDPOINT is required (spec/sdk-conformance.md §3)')
  }
  const stateDir = env['JELTO_STATE_DIR'] ?? ''
  if (stateDir === '') {
    throw new Error('JELTO_STATE_DIR is required (spec/sdk-conformance.md §3)')
  }
  return build(env, stderr, undefined, stateDir)
}

export { DEFAULT_ENDPOINT, resolveEndpoint } from './endpoint.ts'

function build(
  env: NodeJS.ProcessEnv,
  stderr: NodeJS.WritableStream,
  endpointOverride: string | undefined,
  stateDir: string,
): ConformanceSdk {
  const log = new Debug(stderr, env['JELTO_DEBUG'] === '1')
  const endpoint = resolveEndpoint(endpointOverride, env['JELTO_ENDPOINT'], log)

  // The PRESENCE of JELTO_NOW is the pin, so JELTO_NOW=0 is a legal 1970 clock
  // (C15) and not "unset".
  let pin: bigint | null = null
  const rawNow = env['JELTO_NOW']
  if (rawNow !== undefined) {
    pin = parseInstant(rawNow)
    if (pin === null) log.log(`JELTO_NOW ${JSON.stringify(rawNow)} is not a whole number of milliseconds; the clock is not pinned`)
  }

  const mock = env['JELTO_MOCK'] ?? null
  const clientVersion = gateClientVersion(env['JELTO_CLIENT_VERSION'], log)

  return new Engine({
    endpoint,
    stateDir,
    clock: new Clock(pin),
    log,
    stderr,
    mock: mock === '' ? null : mock,
    clientVersion,
    env,
  })
}

/**
 * The state directory a customer gets: spec/sdk-conformance.md §5,
 * `app.getPath('userData')/jelto/`. `electron` is required LAZILY and inside a
 * try/catch, so the bundle loads under plain `node` too — which is what the
 * conformance host runs on, and where JELTO_STATE_DIR overrides this anyway.
 */
function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const override = env['JELTO_STATE_DIR'] ?? ''
  if (override !== '') return override
  const userData = electronApp()?.getPath?.('userData')
  if (typeof userData === 'string' && userData !== '') return `${userData}/jelto`
  // Not an Electron main process. Nothing here may throw into the host, so the
  // SDK falls back rather than refusing to load.
  return `${env['HOME'] ?? env['USERPROFILE'] ?? '.'}/.jelto`
}

let singleton: ConformanceSdk | null = null

function instance(): ConformanceSdk {
  if (singleton === null) {
    singleton = build(process.env, process.stderr, undefined, defaultStateDir(process.env))
  }
  return singleton
}

/** The singleton a customer links: `import jelto from '@jelto/electron'`. */
const jelto: Jelto = {
  init(key: string, app?: string, endpoint?: string): void {
    instance().init(key, app, endpoint)
  },
  track(name: string, props?: Record<string, PropValue>): void {
    instance().track(name, props)
  },
  onboarding(step: string, status: string, reason?: string): void {
    instance().onboarding(step, status, reason)
  },
  setProps(props: Record<string, PropValue>): void {
    instance().setProps(props)
  },
  installId(): string {
    return instance().installId()
  },
  reset(): void {
    instance().reset()
  },
  disable(): void {
    instance().disable()
  },
}

export default jelto
