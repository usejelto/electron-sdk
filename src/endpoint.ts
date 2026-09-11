import type { Debug } from './debug.ts'

/** spec/wire-v1.md §1. The same host spec/snippet.md §1 has defaulted to since v0.1. */
export const DEFAULT_ENDPOINT = 'https://in.jelto.io/v1/e'

/**
 * spec/wire-v1.md §1's precedence: the application's explicit endpoint, else
 * `JELTO_ENDPOINT`, else §1's default. An empty value is an absent value at
 * every level, and a value that is not an absolute URL falls through to the
 * next rather than becoming an endpoint that can only ever fail.
 *
 * THE ENVIRONMENT MUST KEEP BEATING THE DEFAULT, and this is the site that
 * decides it. If the default won, the conformance host would ignore the
 * endpoint its own runner handed it (spec/sdk-conformance.md §3,
 * spec/conformance/runner/run.go) and post real traffic to in.jelto.io -- while
 * the suite reported green the entire time.
 *
 * Why there is a default at all: through wire rev 0.18 the contract named no
 * host, so this SDK passed the empty string to `Transport`, which answered
 * every POST with a network error (`transport.ts`) that RFC-0001 §8.3 item 8
 * then retried forever. A shipped Electron app cannot set an environment
 * variable for itself, so nothing was ever delivered and nothing surfaced.
 */
export function resolveEndpoint(
  argument: string | undefined,
  envValue: string | undefined,
  log?: Debug,
): string {
  for (const [value, source] of [
    [argument, 'endpoint passed to init'],
    [envValue, 'JELTO_ENDPOINT'],
  ] as const) {
    if (value === undefined || value === '') continue
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') return value
      log?.log(`${source} ${JSON.stringify(value)} is not http(s); falling back to spec/wire-v1.md §1's default`)
    } catch {
      log?.log(`${source} ${JSON.stringify(value)} is not an absolute URL; falling back to spec/wire-v1.md §1's default`)
    }
  }
  return DEFAULT_ENDPOINT
}
