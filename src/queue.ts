// Cap live serialized events at 1 MiB or 1,000 entries, dropping oldest first.
// Byte accounting measures live encoded events, not file size. Cap eviction
// appends until dead bytes justify compaction; acknowledgements still checkpoint.

import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { atomicWrite } from './atomic.ts'
import type { QueuedEvent } from './wire.ts'

export const QUEUE_MAX_BYTES = 1 << 20
export const QUEUE_MAX_EVENTS = 1000
const COMPACTION_MIN_BYTES = 64 << 10

interface Entry {
  event: QueuedEvent
  line: string
  bytes: number
}

export class EventQueue {
  private readonly path: string
  private readonly dir: string
  private entries: Entry[] = []
  private total = 0
  private fileBytes = 0
  // A failed append may leave a torn tail. Checkpoint before appending again;
  // failed compaction must not let the file grow beyond its physical bound.
  private needsRewrite = false
  // Survives cap eviction until the state intent can be retired. One ID suffices:
  // the engine completes one handoff before observing another transition.
  private recoveredUpdateID = ''

  constructor(dir: string, path: string) {
    this.dir = dir
    this.path = path
  }

  /**
   * Reads the file if it exists, creating nothing: before `init` the SDK
   * touches no file (C5).
   */
  load(pendingUpdateID?: string): void {
    this.entries = []
    this.total = 0
    this.fileBytes = 0
    this.needsRewrite = false
    this.recoveredUpdateID = ''
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      this.needsRewrite = (error as NodeJS.ErrnoException).code !== 'ENOENT'
      return
    }
    this.fileBytes = Buffer.byteLength(raw, 'utf8')
    this.needsRewrite = raw !== '' && !raw.endsWith('\n')
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let event: QueuedEvent & { recovered_update_id?: string }
      try {
        event = JSON.parse(line) as QueuedEvent & { recovered_update_id?: string }
      } catch {
        // A half-written line from a killed process costs that event, not the
        // file.
        continue
      }
      if (event === null || typeof event !== 'object') continue
      if (typeof event.recovered_update_id === 'string') {
        this.recoveredUpdateID = event.recovered_update_id
        continue
      }
      if (typeof event.id !== 'string' || typeof event.n !== 'string' || typeof event.t !== 'string') continue
      // Legacy checkpoints contain no receipt. Finding the exact pending ID
      // proves handoff before startup trimming or a failed recovery write.
      if (this.recoveredUpdateID === '' && event.id === pendingUpdateID) {
        this.recoveredUpdateID = event.id
        this.needsRewrite = true
      }
      this.push(event, line)
    }
    if (this.trim() > 0 || this.needsRewrite || this.fileBytes > this.fileLimit()) this.rewrite()
  }

  private push(event: QueuedEvent, line: string): void {
    const bytes = Buffer.byteLength(line, 'utf8') + 1 // the newline it is stored with
    this.entries.push({ event, line, bytes })
    this.total += bytes
  }

  /** Enqueues one event and applies both caps, oldest first. */
  append(event: QueuedEvent): number {
    const line = JSON.stringify(event)
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    this.push(event, line)
    const dropped = this.trim()
    // Replaying the append-only file and applying the same caps reconstructs
    // the live suffix. Rewrite only after enough dead bytes have accumulated.
    if (this.needsRewrite || this.fileBytes + bytes > this.fileLimit()) {
      this.rewrite()
    } else {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 })
        appendFileSync(this.path, `${line}\n`, { mode: 0o600 })
        this.fileBytes += bytes
      } catch {
        // The SDK never throws into the host: a queue that cannot be
        // persisted is still held in memory and still sent.
        this.needsRewrite = true
      }
    }
    return dropped
  }

  private trim(): number {
    let dropped = 0
    while (
      this.entries.length > QUEUE_MAX_EVENTS ||
      (this.entries.length > 1 && this.total > QUEUE_MAX_BYTES)
    ) {
      this.total -= this.entries[0]!.bytes
      this.entries.shift()
      dropped += 1
    }
    return dropped
  }

  /**
   * Up to `n` events from the front WITHOUT removing them: a batch is only
   * removed once the server has accepted it, because a retryable failure
   * retries the same batch and spec/wire-v1.md §6 forbids altering its `id`s
   * (C8).
   */
  head(n: number): QueuedEvent[] {
    return this.entries.slice(0, n).map((entry) => entry.event)
  }

  /** Drops the first `n`. Called only on a 202 or on a final refusal. */
  remove(n: number): void {
    const count = Math.min(n, this.entries.length)
    for (let i = 0; i < count; i += 1) this.total -= this.entries[i]!.bytes
    this.entries = this.entries.slice(count)
    this.rewrite()
  }

  /** A cap eviction during an HTTP request must not acknowledge newer, unsent events. */
  removeIDs(ids: ReadonlySet<string>): void {
    this.entries = this.entries.filter((entry) => !ids.has(entry.event.id))
    this.total = this.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    this.rewrite()
  }

  get length(): number {
    return this.entries.length
  }

  get byteCount(): number {
    return this.total
  }

  /**
   * `install` is enqueued once per launch at most, and only when the previous
   * launch's copy is not still waiting (C4's "exactly one", C4b).
   */
  contains(name: string): boolean {
    return this.entries.some((entry) => entry.event.n === name)
  }

  /** Recovery uses the original ID, even if the previous process appended it already. */
  recover(event: QueuedEvent): boolean {
    const before = { entries: this.entries, total: this.total, recoveredUpdateID: this.recoveredUpdateID }
    this.entries = [...this.entries]
    if (this.recoveredUpdateID !== event.id) {
      if (!this.entries.some((entry) => entry.event.id === event.id)) this.push(event, JSON.stringify(event))
      this.recoveredUpdateID = event.id
      this.trim()
    }
    const contents = this.contents()
    if (atomicWrite(this.path, contents)) {
      this.fileBytes = Buffer.byteLength(contents, 'utf8')
      this.needsRewrite = false
      return true
    }
    this.entries = before.entries
    this.total = before.total
    this.recoveredUpdateID = before.recoveredUpdateID
    return false
  }

  discardUpdates(): boolean {
    const next = this.entries.filter((entry) => entry.event.n !== 'app_updated')
    const contents = this.receiptLine() + next.map((entry) => `${entry.line}\n`).join('')
    if (!atomicWrite(this.path, contents)) return false
    this.entries = next
    this.total = this.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    this.fileBytes = Buffer.byteLength(contents, 'utf8')
    this.needsRewrite = false
    return true
  }

  /** spec/sdk-conformance.md §3.2's `queue`: oldest first, `id`/`n`/`t` only. */
  exported(): Array<{ id: string; n: string; t: string }> {
    return this.entries.map((entry) => ({ id: entry.event.id, n: entry.event.n, t: entry.event.t }))
  }

  /** disable()'s half of deleting the queue and the install_id (C18). */
  delete(): void {
    this.entries = []
    this.total = 0
    this.recoveredUpdateID = ''
    try {
      rmSync(this.path, { force: true })
      this.fileBytes = 0
      this.needsRewrite = false
    } catch {
      // Swallowed: the SDK never throws into the host.
      this.needsRewrite = true
    }
  }

  private rewrite(): void {
    this.needsRewrite = true
    try {
      if (this.entries.length === 0 && this.recoveredUpdateID === '') {
        rmSync(this.path, { force: true })
        this.fileBytes = 0
        this.needsRewrite = false
        return
      }
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const contents = this.contents()
      if (atomicWrite(this.path, contents, false)) {
        this.fileBytes = Buffer.byteLength(contents, 'utf8')
        this.needsRewrite = false
      }
    } catch {
      // Swallowed: the SDK never throws into the host.
    }
  }

  /** At most one live queue of dead bytes, or 64 KiB for small queues. */
  private fileLimit(): number {
    return this.total + Math.max(this.total, COMPACTION_MIN_BYTES)
  }

  private receiptLine(): string {
    return this.recoveredUpdateID === '' ? '' : `${JSON.stringify({ recovered_update_id: this.recoveredUpdateID })}\n`
  }

  private contents(): string {
    return this.receiptLine() + this.entries.map((entry) => `${entry.line}\n`).join('')
  }
}
