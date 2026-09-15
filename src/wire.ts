// Validate spec/wire-v1.md grammars before encoding. Splice numeric literals
// directly to preserve bigint timestamps; JSON.stringify handles strings only.
// Fixed property order preserves C20 equivalence, and byte limits apply to actual output.

import { Debug } from './debug.ts'

/** spec/wire-v1.md §2/§3/§4's numbers. */
export const MAX_BODY_BYTES = 65_536
export const MAX_EVENTS_PER_REQUEST = 100
export const MAX_PROPS = 20
export const MAX_PROP_STRING = 200
export const MAX_REASON_CHARS = 64

/** The client version follows the `electron/1.0.3` shape (spec/wire-v1.md §3). */
export const SDK_CLIENT_VERSION = 'electron/1.0.1'

export type PropValue = string | number | boolean

/** Host knowledge at the first claim, never inferred from the SDK identity. */
export type InstallOrigin = 'new' | 'existing' | 'unknown'
export function installOrigin(value: unknown): InstallOrigin {
  return value === 'new' || value === 'existing' ? value : 'unknown'
}

/**
 * What the queue holds. Only what cannot be recomputed at send time: §4 says a
 * `heartbeat` "carries the app's CURRENT values every time", so install
 * properties are resolved when the request is built and never frozen in here
 * (C22's first heartbeat carries a `license` set after it was enqueued).
 *
 * `t` is the clock's DECIMAL DIGITS, not a number — see the file header.
 */
export interface QueuedEvent {
  id: string
  n: string
  t: string
  props?: Record<string, PropValue>
  /** Marks the events whose props come from the install properties at send time. */
  hb?: boolean
  metadata?: EventMetadata
}

export interface EventMetadata {
  av: string
  os: string
  osv: string
  arch: string
  slug: string | null
  clientVersion: string | null
  installID?: string
}


/** §3 `n`. */
export const RE_EVENT_NAME = /^[a-z0-9_:.-]{1,64}$/
/** §3 `props` key. */
export const RE_PROP_KEY = /^[a-z0-9_]{1,32}$/
/** §4 install-property value — one grammar for all of them, `license` included. */
export const RE_INSTALL_PROP_VALUE = /^[a-z0-9_.-]{1,24}$/
/** §4 onboarding `<step>`. */
export const RE_ONBOARDING_STEP = /^[a-z0-9_-]{1,32}$/
/** §4 onboarding `reason`. */
export const RE_ONBOARDING_REASON = /^[a-z0-9_.-]+$/
/** §3 `v`, normative since rev 0.16. */
export const RE_CLIENT_VERSION = /^[a-z]+\/[0-9A-Za-z.+-]{1,24}$/
/** §5.2 `a`. */
export const RE_APP_SLUG = /^[a-z0-9-]{1,32}$/
/** A whole decimal, which is the only thing that may be spliced in as `t`. */
const RE_DECIMAL = /^-?[0-9]+$/

//
// A refusal costs the whole EVENT, not the field, and writes exactly one line.
// The scenarios assert on the substrings below verbatim; see
// src/stderr.test.ts, which pins every one of them to the path that owes it.

/** W2. `null` means: this name may not be sent. */
export function gateEventName(name: string, log: Debug): string | null {
  // The `typeof` guards in this file are not belt-and-braces: the declarations
  // are erased at run time and a JavaScript host can pass anything, while the
  // SDK never throws into it. A value of the wrong type
  // is a client-side drop with a line, exactly like a value of the wrong shape.
  if (typeof name !== 'string' || !RE_EVENT_NAME.test(name)) {
    log.log(`drop event ${Debug.display(name)}: spec/wire-v1.md §3 \`n\` is ^[a-z0-9_:.-]{1,64}$`)
    return null
  }
  return name
}

/** W3. Order is fixed so the FIRST failure logged is deterministic. */
export function gateTrackProps(props: Record<string, PropValue> | undefined, eventName: string, log: Debug): boolean {
  if (props === undefined || props === null) return true
  if (typeof props !== 'object' || Array.isArray(props)) {
    log.log(`drop event ${Debug.display(eventName)}: props must be an object; spec/wire-v1.md §3`)
    return false
  }
  const origin = props['install_origin']
  if ('install_origin' in props && (eventName !== 'install' ||
    (origin !== 'new' && origin !== 'existing' && origin !== 'unknown'))) {
    log.log('drop event: install_origin is reserved for install and must be new, existing or unknown')
    return false
  }
  const keys = Object.keys(props).sort(byUTF8Bytes)
  if (keys.length === 0) return true

  if (keys.length > MAX_PROPS) {
    log.log(
      `drop event ${Debug.display(eventName)}: props has ${keys.length} keys, spec/wire-v1.md §3 caps them at ${MAX_PROPS}`,
    )
    return false
  }
  for (const key of keys) {
    if (!RE_PROP_KEY.test(key)) {
      log.log(
        `drop event ${Debug.display(eventName)}: props key ${Debug.display(key)} does not match spec/wire-v1.md §3's ^[a-z0-9_]{1,32}$`,
      )
      return false
    }
  }
  for (const key of keys) {
    const value = props[key]
    if (typeof value === 'string' && [...value].length > MAX_PROP_STRING) {
      log.log(
        `drop event ${Debug.display(eventName)}: props value for ${Debug.display(key)} is ${[...value].length} chars, spec/wire-v1.md §3 caps a string at ${MAX_PROP_STRING}`,
      )
      return false
    }
  }
  for (const key of keys) {
    const value = props[key]
    if (typeof value === 'number' && !Number.isFinite(value)) {
      log.log(
        `drop event ${Debug.display(eventName)}: props value for ${Debug.display(key)} is not a JSON number; spec/wire-v1.md §3 allows a string, a number or a boolean`,
      )
      return false
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      log.log(
        `drop event ${Debug.display(eventName)}: props value for ${Debug.display(key)} is ${typeof value}; spec/wire-v1.md §3 allows a string, a number or a boolean`,
      )
      return false
    }
  }
  return true
}

/**
 * The onboarding sugar and C20's trap. Returns `("onboarding:" + step, props)`
 * and nothing else — the caller feeds it to the SAME `track` path, which is
 * what C20's congruence check is looking for. C20b's two rows are here.
 */
export function gateOnboarding(
  step: string,
  status: string,
  reason: string | undefined,
  log: Debug,
): { name: string; props: Record<string, PropValue> } | null {
  if (typeof step !== 'string' || !RE_ONBOARDING_STEP.test(step)) {
    log.log(`drop onboarding step ${Debug.display(step)}: spec/wire-v1.md §4 \`<step>\` is ^[a-z0-9_-]{1,32}$`)
    return null
  }
  if (status !== 'ok' && status !== 'fail' && status !== 'skip') {
    log.log(
      `drop onboarding step ${Debug.display(step)}: spec/wire-v1.md §4 \`status\` is ok|fail|skip, not ${Debug.display(status)}`,
    )
    return null
  }
  const props: Record<string, PropValue> = { status }
  if (reason !== undefined && reason !== null && reason !== '') {
    if (typeof reason !== 'string' || !RE_ONBOARDING_REASON.test(reason) || [...reason].length > MAX_REASON_CHARS) {
      log.log(
        `drop onboarding step ${Debug.display(step)}: spec/wire-v1.md §4 \`reason\` is ^[a-z0-9_.-]+$ and <= ${MAX_REASON_CHARS} chars, not ${Debug.display(reason)}`,
      )
      return null
    }
    props['reason'] = reason
  }
  return { name: `onboarding:${step}`, props }
}

/**
 * C22c. Key first, then value, `continue` on either, so at most one line is
 * logged per rejected key and one bad key does not cost the good ones.
 */
export function gateInstallProps(raw: Record<string, PropValue>, log: Debug): Record<string, string> {
  const accepted: Record<string, string> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    log.log('drop setprops: spec/wire-v1.md §4 install properties are an object of string values')
    return accepted
  }
  for (const key of Object.keys(raw).sort(byUTF8Bytes)) {
    if (key === 'install_origin') {
      log.log('drop install_origin: reserved for the install claim initialization option')
      continue
    }
    const value = raw[key]
    if (typeof value !== 'string') {
      log.log(
        `drop install property ${Debug.display(key)}: spec/wire-v1.md §4 install-property values are strings matching ^[a-z0-9_.-]{1,24}$`,
      )
      continue
    }
    if (!RE_PROP_KEY.test(key)) {
      log.log(`drop install property ${Debug.display(key)}: spec/wire-v1.md §3 \`props\` keys are ^[a-z0-9_]{1,32}$`)
      continue
    }
    if (!RE_INSTALL_PROP_VALUE.test(value)) {
      log.log(
        `drop install property ${Debug.display(key)}: spec/wire-v1.md §4 install-property values are ^[a-z0-9_.-]{1,24}$, not ${Debug.display(value)}`,
      )
      continue
    }
    accepted[key] = value
  }
  return accepted
}

/** §3's cap applies to a heartbeat's install properties too (wire rev 0.16, W3). */
export function withinPropCap(merged: Record<string, string>, log: Debug): boolean {
  const count = Object.keys(merged).length
  if (count <= MAX_PROPS) return true
  log.log(`drop setprops: ${count} install properties, spec/wire-v1.md §3 caps them at ${MAX_PROPS}`)
  return false
}

/**
 * W4's three-way distinction. Unset -> the SDK's own `v`. Set-but-EMPTY -> no
 * `v`, silently: §3 says an empty `v` is an absent `v`. Anything else outside
 * the grammar -> no `v`, with a line, and NEVER a fall-back to a bare number:
 * the server answers `invalid_field` naming `v` for every event a build with a
 * bad one sends, for the life of that build.
 */
export function gateClientVersion(override: string | undefined, log: Debug): string | null {
  if (override === undefined) return SDK_CLIENT_VERSION
  if (override === '') return null
  if (RE_CLIENT_VERSION.test(override) && [...override].length <= 32) return override
  log.log(
    `client version ${Debug.display(override)} does not match spec/wire-v1.md §3's ^[a-z]+/[0-9A-Za-z.+-]{1,24}$; \`v\` is omitted`,
  )
  return null
}

/** §5.2 `a`. `null` for absent and for `""` — an empty `a` is an absent `a`. */
export function gateAppSlug(raw: string | undefined, log: Debug): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !RE_APP_SLUG.test(raw)) {
    log.log(`drop app slug ${Debug.display(raw)}: spec/wire-v1.md §5.2 \`a\` is ^[a-z0-9-]{1,32}$`)
    return null
  }
  return raw
}

/** Ascending UTF-8 byte order. Every gated key is ASCII, so this is exact. */
export function byUTF8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}


function encodeValue(value: PropValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function encodeProps(props: Record<string, PropValue>): string {
  const keys = Object.keys(props).sort(byUTF8Bytes)
  const parts: string[] = []
  for (const key of keys) parts.push(`${JSON.stringify(key)}:${encodeValue(props[key] as PropValue)}`)
  return `{${parts.join(',')}}`
}

export interface EncodeContext {
  installID: string
  av: string
  os: string
  osv: string
  arch: string
  slug: string | null
  clientVersion: string | null
  installProps: Record<string, string>
}

/**
 * One event object: `id, n, t, s, iid, av, os, osv, arch, [a], [v], [props]`.
 * Trusts its input — gating already happened at the call site where a log line
 * has a meaning. `null` only for a `t` that is not a whole decimal, which no
 * path in this SDK can produce (every `t` comes from `bigint.toString()`);
 * the guard is here because splicing an unchecked string into a body is how a
 * hand-written encoder gets an injection.
 */
export function encodeEvent(event: QueuedEvent, ctx: EncodeContext): string | null {
  if (!RE_DECIMAL.test(event.t)) return null
  if (event.metadata !== undefined) ctx = { ...ctx, ...event.metadata }
  let out = `{"id":${JSON.stringify(event.id)}`
  out += `,"n":${JSON.stringify(event.n)}`
  out += `,"t":${event.t}` // the decimal digits, as a bare JSON number (C15b)
  out += ',"s":"app"' // this is the app SDK; §5.1 has no path here
  out += `,"iid":${JSON.stringify(ctx.installID)}`
  out += `,"av":${JSON.stringify(ctx.av)}`
  out += `,"os":${JSON.stringify(ctx.os)}`
  out += `,"osv":${JSON.stringify(ctx.osv)}`
  out += `,"arch":${JSON.stringify(ctx.arch)}`
  if (ctx.slug !== null) out += `,"a":${JSON.stringify(ctx.slug)}`
  if (ctx.clientVersion !== null && ctx.clientVersion !== '') out += `,"v":${JSON.stringify(ctx.clientVersion)}`

  const chosen: Record<string, PropValue> = event.hb === true ? { ...ctx.installProps } : (event.props ?? {})
  if (event.hb === true) delete chosen['install_origin']
  if (Object.keys(chosen).length > 0) out += `,"props":${encodeProps(chosen)}`
  out += '}'
  return out
}

/**
 * `{"v":1,"p":<key>,"e":[...]}`, assembled by hand so §2's 65 536 bytes and
 * 100 events are measured on the bytes actually sent. Walks in order and
 * BREAKS on the first event that does not fit — never skips one and continues,
 * because `used` is a PREFIX count the caller feeds to `queue.remove(used)`.
 */
export function buildEnvelope(productKey: string, events: string[]): { body: Buffer; used: number } {
  const head = `{"v":1,"p":${JSON.stringify(productKey)},"e":[`
  let length = Buffer.byteLength(head, 'utf8')
  const taken: string[] = []
  for (const event of events) {
    if (taken.length >= MAX_EVENTS_PER_REQUEST) break
    const extra = (taken.length > 0 ? 1 : 0) + Buffer.byteLength(event, 'utf8') + 2 // comma + event + `]}`
    if (length + extra > MAX_BODY_BYTES) break
    taken.push(event)
    length += extra - 2
  }
  if (taken.length === 0) return { body: Buffer.alloc(0), used: 0 }
  return { body: Buffer.from(`${head}${taken.join(',')}]}`, 'utf8'), used: taken.length }
}


export interface Rejection {
  i: number
  reason: string
  field: string
}

export interface StopDirective {
  /** wire §8 sends `until` in Unix SECONDS. `null` when it is not whole seconds. */
  untilSeconds: bigint | null
  untilText: string
  scope: string
}

export interface ServerResponse {
  rejected: Rejection[]
  stop: StopDirective | null
  error: string
}

/**
 * The part of a body an SDK acts on: spec/wire-v1.md §6's `rejected`, §8's
 * `stop`, §2a's `error`. Nothing else is read, and an unreadable body is a
 * swallowed failure, never a retry, since the SDK never throws into the host.
 *
 * `stop.until`'s digits are lifted from the RAW TEXT rather than from
 * `JSON.parse`'s `number`, for the same reason `t` is: a `number` is a double.
 * Unix seconds are far inside the safe range today, so this is insurance
 * rather than a live bug — but it is the same class of bug as C15b's.
 */
export function parseResponse(body: Buffer): ServerResponse | null {
  const text = body.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const object = parsed as Record<string, unknown>

  const rejected: Rejection[] = []
  if (Array.isArray(object['rejected'])) {
    for (const entry of object['rejected'] as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      rejected.push({
        i: typeof row['i'] === 'number' ? row['i'] : -1,
        reason: typeof row['reason'] === 'string' ? row['reason'] : '',
        field: typeof row['field'] === 'string' ? row['field'] : '',
      })
    }
  }

  let stop: StopDirective | null = null
  const rawStop = object['stop']
  if (rawStop !== null && typeof rawStop === 'object' && !Array.isArray(rawStop)) {
    const row = rawStop as Record<string, unknown>
    const scope = typeof row['scope'] === 'string' ? row['scope'] : ''
    // Scoped to the `"stop":{...}` object itself (no nested `{`/`}` inside it):
    // an unscoped search would match the FIRST `"until"` anywhere in the body,
    // including one planted in an unrelated field such as a `rejected` entry.
    const literal = /"stop"\s*:\s*\{[^{}]*"until"\s*:\s*(-?[0-9]+)/.exec(text)
    const digits = literal?.[1]
    // A 15-digit magnitude comfortably covers any real Unix-seconds value
    // (10 digits today) with room to spare; anything longer is treated as
    // absent rather than handed to BigInt() as a trusted deadline.
    const withinRange = digits !== undefined && digits.replace(/^-/, '').length <= 15
    let untilSeconds: bigint | null = null
    let untilText = ''
    if (withinRange) {
      untilText = digits
      untilSeconds = BigInt(digits)
    } else if (typeof row['until'] === 'number' && Number.isSafeInteger(row['until'])) {
      untilText = String(row['until'])
      untilSeconds = BigInt(row['until'] as number)
    } else {
      untilText = digits ?? String(row['until'])
    }
    stop = { untilSeconds, untilText, scope }
  }

  return { rejected, stop, error: typeof object['error'] === 'string' ? object['error'] : '' }
}
