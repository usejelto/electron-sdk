// Persist exact instants as decimal strings. Storage format is private to the SDK;
// engine.exportState exposes the semantic contract in spec/sdk-conformance.md §3.2.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic.ts'
import type { QueuedEvent } from './wire.ts'

/**
 * Every filesystem entry this SDK, across `store.ts`, `queue.ts` and
 * `atomic.ts`, ever creates in the state directory: the two checkpoints and
 * `atomicWrite`'s own `.tmp` siblings. Nothing else in that directory is
 * this SDK's to delete.
 */
const OWNED_ENTRIES = ['state.json', 'state.json.tmp', 'queue.jsonl', 'queue.jsonl.tmp']

export interface PersistedState {
  install_id: string
  last_app_version: string
  pending_update?: QueuedEvent
  /** UTC day index, decimal (C3). */
  last_heartbeat_day: string
  install_claimed: boolean
  /** The install's random 0-6 h delay, a DEADLINE and not a countdown (C4c). */
  install_due_at: string
  /** The "after 30 days of attempts" claim has to be measured from something (C4b). */
  install_first_try: string
  install_props: Record<string, string>
  /** The backoff step in ms; 0 means "not in backoff". */
  backoff_step_ms: number
  backoff_next_at: string
  /** Consecutive refusals. §3.2 rules this OUT of the export; it is bookkeeping. */
  backoff_failures: number
  /** The kill switch deadline, absolute MILLISECONDS on the SDK clock (wire §8 sends seconds). */
  stop_until: string
  stop_probe_due: boolean
}

export function emptyState(): PersistedState {
  return {
    install_id: '',
    last_app_version: '',
    last_heartbeat_day: '',
    install_claimed: false,
    install_due_at: '',
    install_first_try: '',
    install_props: {},
    backoff_step_ms: 0,
    backoff_next_at: '',
    backoff_failures: 0,
    stop_until: '',
    stop_probe_due: false,
  }
}

export class Store {
  readonly dir: string
  private readonly file: string
  private state: PersistedState = emptyState()

  constructor(dir: string) {
    this.dir = dir
    this.file = join(dir, 'state.json')
  }

  get queuePath(): string {
    return join(this.dir, 'queue.jsonl')
  }

  /**
   * Reads state.json, creating neither the file nor the directory when it is
   * absent (C5). A file that cannot be parsed is treated as absent: a corrupt
   * state costs an install id, not a crash, since the SDK never throws into
   * the host.
   */
  load(): PersistedState {
    this.state = emptyState()
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return this.state
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      const base = emptyState()
      this.state = {
        install_id: typeof parsed.install_id === 'string' ? parsed.install_id : base.install_id,
        last_app_version: typeof parsed.last_app_version === 'string' ? parsed.last_app_version : '',
        pending_update: isPendingUpdate(parsed.pending_update) ? parsed.pending_update : undefined,
        last_heartbeat_day:
          typeof parsed.last_heartbeat_day === 'string' ? parsed.last_heartbeat_day : base.last_heartbeat_day,
        install_claimed: parsed.install_claimed === true,
        install_due_at: typeof parsed.install_due_at === 'string' ? parsed.install_due_at : base.install_due_at,
        install_first_try:
          typeof parsed.install_first_try === 'string' ? parsed.install_first_try : base.install_first_try,
        install_props: isStringMap(parsed.install_props) ? parsed.install_props : base.install_props,
        backoff_step_ms: typeof parsed.backoff_step_ms === 'number' ? parsed.backoff_step_ms : base.backoff_step_ms,
        backoff_next_at: typeof parsed.backoff_next_at === 'string' ? parsed.backoff_next_at : base.backoff_next_at,
        backoff_failures:
          typeof parsed.backoff_failures === 'number' ? parsed.backoff_failures : base.backoff_failures,
        stop_until: typeof parsed.stop_until === 'string' ? parsed.stop_until : base.stop_until,
        stop_probe_due: parsed.stop_probe_due === true,
      }
    } catch {
      this.state = emptyState()
    }
    return this.state
  }

  get(): PersistedState {
    return this.state
  }

  /** Mutate and persist together, so a crash between the two is the only way
   * they can disagree. */
  update(mutate: (state: PersistedState) => void): PersistedState {
    mutate(this.state)
    this.persist()
    return this.state
  }

  private persist(): void {
    atomicWrite(this.file, JSON.stringify(this.state))
  }

  /** Failed transition commits leave both the committed baseline and memory intact. */
  commit(mutate: (state: PersistedState) => void): boolean {
    const next = structuredClone(this.state)
    mutate(next)
    if (!atomicWrite(this.file, JSON.stringify(next))) return false
    this.state = next
    return true
  }

  /**
   * disable() deletes the queue and the install_id. C18 and C22d assert the
   * state directory holds nothing this SDK put there afterwards — but ONLY
   * what this SDK put there: a directory it was merely handed
   * (spec/sdk-conformance.md §5) can hold a customer's own files, and
   * disable() is not license to delete those too.
   */
  wipe(): void {
    this.state = emptyState()
    for (const name of OWNED_ENTRIES) {
      try {
        rmSync(join(this.dir, name), { force: true })
      } catch {
        // The directory may not exist; nothing to wipe.
      }
    }
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string')
}

function isPendingUpdate(value: unknown): value is QueuedEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<QueuedEvent>
  const metadata = event.metadata
  return typeof event.id === 'string' && event.id !== '' && event.n === 'app_updated'
    && typeof event.t === 'string' && /^-?\d+$/.test(event.t)
    && isStringMap(event.props) && typeof event.props['from_version'] === 'string'
    && typeof event.props['to_version'] === 'string' && metadata !== null && typeof metadata === 'object'
    && typeof metadata.av === 'string' && typeof metadata.os === 'string'
    && typeof metadata.osv === 'string' && typeof metadata.arch === 'string'
    && typeof metadata.installID === 'string'
    && (metadata.slug === null || typeof metadata.slug === 'string')
    && (metadata.clientVersion === null || typeof metadata.clientVersion === 'string')
}
