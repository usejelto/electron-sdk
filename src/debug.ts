// Debug output is opt-in; disabled logging must leave stderr byte-empty (C10).

export class Debug {
  private readonly out: NodeJS.WritableStream
  private readonly enabled: boolean

  constructor(out: NodeJS.WritableStream, enabled: boolean) {
    this.out = out
    this.enabled = enabled
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** One line: `jelto: ` + message + newline. */
  log(message: string): void {
    if (!this.enabled) return
    this.out.write(`jelto: ${message}\n`)
  }

  /**
   * One line: `jelto: POST ` + the body UNALTERED + newline. C17 compares
   * stderr against the bytes mockd received with a substring test, so a prefix
   * on the same line is fine and an altered byte is not — no pretty-printing,
   * no re-encoding, no truncation.
   */
  payload(body: Buffer): void {
    if (!this.enabled) return
    this.out.write(Buffer.concat([Buffer.from('jelto: POST ', 'utf8'), body, Buffer.from('\n', 'utf8')]))
  }

  /**
   * Quotes a caller-supplied string for a log line: control characters become
   * `?` and the text is truncated to 120 code points. Every log line must stay
   * ONE line — a newline inside a rejected event name would split a line a
   * scenario expects whole.
   */
  static display(value: unknown): string {
    // `unknown`, not `string`: RFC-0001 §8.3 item 10 forbids throwing into the
    // host, and a JavaScript caller can hand any type past the declaration.
    const text = typeof value === 'string' ? value : safeString(value)
    let inner = ''
    let truncated = false
    let seen = 0
    for (const ch of text) {
      if (seen >= 120) {
        truncated = true
        break
      }
      const code = ch.codePointAt(0) ?? 0
      inner += code < 0x20 || code === 0x7f ? '?' : ch
      seen += 1
    }
    return `"${inner}${truncated ? '…' : ''}"`
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[unprintable]'
  }
}
