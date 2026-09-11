import type { Debug } from './debug.ts'

/** spec/wire-v1.md §1's default endpoint. The same host the web snippet has defaulted to since v0.1. */
export const DEFAULT_ENDPOINT = 'https://in.jelto.io/v1/e'

/**
 * spec/wire-v1.md §1's precedence: the application's explicit endpoint, else
 * `JELTO_ENDPOINT`, else §1's default. An empty value is an absent value at
 * every level. A NON-EMPTY value that is not an absolute http(s) URL without
 * userinfo does NOT fall through to the next tier: spec/wire-v1.md §1 makes
 * that an invalid endpoint, and an invalid explicit configuration must not be
 * silently swapped for a different destination. The result is `null`: the
 * caller's engine goes inactive rather than guessing where "invalid" meant
 * to send.
 *
 * THE ENVIRONMENT MUST KEEP BEATING THE DEFAULT, and this is the site that
 * decides it. If the default won, the conformance host would ignore the
 * endpoint its own runner handed it (spec/sdk-conformance.md §3) and post
 * real traffic to in.jelto.io -- while the suite reported green the entire
 * time.
 *
 * Why there is a default at all: through wire rev 0.18 the contract named no
 * host, so this SDK passed the empty string to `Transport`, which answered
 * every POST with a network error (`transport.ts`) that the retryable-failure
 * class then retried forever. A shipped Electron app cannot set an
 * environment variable for itself, so nothing was ever delivered and nothing
 * surfaced.
 */
export function resolveEndpoint(
  argument: string | undefined,
  envValue: string | undefined,
  log?: Debug,
): string | null {
  for (const [value, source] of [
    [argument, 'endpoint passed to init'],
    [envValue, 'JELTO_ENDPOINT'],
  ] as const) {
    if (value === undefined || value === '') continue
    return validateEndpoint(value, source, log)
  }
  return DEFAULT_ENDPOINT
}

/**
 * A single tier of §1's rule: a non-empty value is either an absolute http(s)
 * URL carrying no userinfo, or the SDK is inactive -- never a fall-through.
 */
export function validateEndpoint(value: string, source: string, log?: Debug): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    log?.log(`${source} ${JSON.stringify(value)} is not an absolute URL; spec/wire-v1.md §1 makes the SDK inactive rather than falling through`)
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    log?.log(`${source} ${JSON.stringify(value)} is not http(s); spec/wire-v1.md §1 makes the SDK inactive rather than falling through`)
    return null
  }
  if (url.username !== '' || url.password !== '') {
    log?.log(`${source} ${JSON.stringify(value)} carries userinfo, which spec/wire-v1.md §1 forbids; the SDK is inactive rather than falling through`)
    return null
  }
  return value
}
