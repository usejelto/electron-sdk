// Use one real-time ClientRequest timeout covering headers and body in both
// clock modes. Connection refusals and mid-request hangups are retryable errors.
// Disable pooling so closed mock connections cannot be reused and connection
// counts remain observable to conformance tests.

import * as http from 'node:http'
import * as https from 'node:https'
import type { Debug } from './debug.ts'

/** The network request timeout that governs the retryable-failure class. */
export const REQUEST_TIMEOUT_MS = 5_000

/**
 * spec/sdk-conformance.md §2/§3's `X-Mock` carries JELTO_MOCK verbatim into a
 * header value. Node's http client throws synchronously on a value outside
 * this range (for example a bare `\n`, which would otherwise inject a second
 * header line); this SDK drops the value instead of ever attempting to set it.
 */
const MOCK_HEADER_SAFE = /^[\x21-\x7e]+$/

/**
 * Bounds what is read back. mockd's `huge` mode answers 8 MiB (C10,
 * "oversized bodies"); an SDK that buffered it would blow its own bounded
 * memory ceiling on a server bug.
 */
export const RESPONSE_READ_CAP = 1 << 20

export interface Outcome {
  status: number
  body: Buffer
  /** The raw header text, or `null` when it was ABSENT — never `"0"` (§9). */
  retryAfter: string | null
  error: string | null
  retryable: boolean
}

export class Transport {
  private readonly url: URL | null
  private readonly endpoint: string
  private readonly mock: string | null
  private readonly log?: Debug
  private readonly agent: http.Agent | https.Agent | null

  constructor(endpoint: string, mock: string | null, log?: Debug) {
    this.endpoint = endpoint
    this.mock = mock
    this.log = log
    let url: URL | null = null
    try {
      url = new URL(endpoint)
    } catch {
      url = null
    }
    this.url = url
    if (url === null) {
      this.agent = null
    } else {
      this.agent = url.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
    }
  }

  /** Never rejects. Every failure is an `Outcome`, since the SDK never throws into the host. */
  post(body: Buffer): Promise<Outcome> {
    const url = this.url
    if (url === null) {
      return Promise.resolve(networkError(`endpoint ${JSON.stringify(this.endpoint)} is not a URL`))
    }
    return new Promise<Outcome>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null
      const settle = (outcome: Outcome): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolve(outcome)
      }

      // This SDK must never throw into the host. Node's http client throws
      // SYNCHRONOUSLY for some malformed inputs (an `X-Mock` value hostile
      // enough to inject a header, for one) and without this try/catch that
      // throw would escape the executor and turn "never rejects" into a
      // broken promise instead of a retryable `Outcome`.
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Content-Length': String(body.byteLength),
        }
        // spec/sdk-conformance.md §2/§3: the host forwards JELTO_MOCK verbatim,
        // but only a value that cannot smuggle a second header ever becomes one.
        if (this.mock !== null && this.mock !== '') {
          if (MOCK_HEADER_SAFE.test(this.mock)) {
            headers['X-Mock'] = this.mock
          } else {
            this.log?.log(`JELTO_MOCK ${JSON.stringify(this.mock)} is outside the header-safe ASCII range; dropping it rather than sending a malformed header`)
          }
        }

        const transport = url.protocol === 'https:' ? https : http
        const request = transport.request(
          {
            protocol: url.protocol,
            // `URL#hostname` keeps an IPv6 literal's brackets (`[::1]`), which
            // are URI syntax rather than part of the address itself; Node's
            // low-level connect options want the bare address.
            hostname: url.hostname.replace(/^\[|\]$/g, ''),
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers,
            agent: this.agent ?? undefined,
          },
          (response) => {
            const chunks: Buffer[] = []
            let read = 0
            response.on('data', (chunk: Buffer) => {
              if (read >= RESPONSE_READ_CAP) return
              read += chunk.byteLength
              chunks.push(chunk)
              if (read >= RESPONSE_READ_CAP) response.destroy()
            })
            const finish = (): void => {
              const status = response.statusCode ?? 0
              const header = response.headers['retry-after']
              settle({
                status,
                body: Buffer.concat(chunks).subarray(0, RESPONSE_READ_CAP),
                retryAfter: typeof header === 'string' ? header : Array.isArray(header) ? (header[0] ?? null) : null,
                error: null,
                // Retryable failures are ONLY a network error, a 429 and a 503.
                retryable: status === 429 || status === 503,
              })
            }
            response.on('end', finish)
            response.on('close', finish)
            response.on('error', (error: Error) => {
              if (chunks.length > 0 || response.statusCode !== undefined) finish()
              else settle(networkError(error.message))
            })
          },
        )

        timer = setTimeout(() => {
          settle(networkError(`no answer within ${REQUEST_TIMEOUT_MS} ms`))
          request.destroy()
        }, REQUEST_TIMEOUT_MS)

        request.on('error', (error: Error) => {
          settle(networkError(error.message))
        })
        request.end(body)
      } catch (error) {
        settle(networkError(error instanceof Error ? error.message : String(error)))
      }
    })
  }

  /** Leaves no live handle behind — §3's `exit` must not hang the host. */
  close(): void {
    this.agent?.destroy()
  }
}

function networkError(message: string): Outcome {
  return { status: 0, body: Buffer.alloc(0), retryAfter: null, error: message, retryable: true }
}
