// Write one JSON reply per completed command and nothing else to stdout.
// cmd echoes the command; optional value, state, and us carry results.
// Exit timing statistics supplement the shared harness's skipped C11 check.

export interface Reply {
  cmd: string
  ok: boolean
  error?: string
  value?: string
  /** §3.2's export, passed through from the SDK. The host does not shape it. */
  state?: unknown
  us?: number

  tracks?: number
  track_p50_us?: number
  track_p99_us?: number
  /**
   * `process.memoryUsage().heapUsed` across the run. It is a HEAP delta and is
   * named one: C11's ceiling is on RSS, this is not that measurement, and the
   * runner skips C11 for the reference host for the same kind of reason.
   */
  heap_delta_kib?: number
}

/**
 * One reply, one line. `JSON.stringify` drops keys whose value is `undefined`,
 * which is how an absent `error`/`value`/`us` stays off the line, and escapes
 * every newline inside a string, so the line break appended here is the only
 * one in the result.
 */
export function encodeReply(reply: Reply): string {
  return JSON.stringify(reply) + '\n'
}

/**
 * Writes one line and resolves when the stream has flushed it.
 *
 * stdout to a pipe is ASYNCHRONOUS on macOS, and the runner drives the host
 * through a pipe (`spec/conformance/runner/hostproc.go`, `StartHost`). Without
 * awaiting the write callback the last reply before `process.exit` can be lost
 * and two replies can be observed out of order, which the runner reads as the
 * answer to the wrong command.
 *
 * A write error is swallowed on purpose: C4c kills the host mid-run, and the
 * EPIPE that follows is the harness doing its job, not a fault to report.
 */
export function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(line, () => resolve())
  })
}
