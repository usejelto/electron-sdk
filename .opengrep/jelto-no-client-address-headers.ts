declare const request: Request
declare const response: Response
declare const incoming: { headers: Record<string, string | undefined> }
declare const express: { get(name: string): string | undefined; header(name: string): string | undefined }

// ruleid: jelto-no-client-address-headers
export const forwardedFor = request.headers.get('x-forwarded-for')
// ruleid: jelto-no-client-address-headers
export const realIP = request.headers.get('X-Real-IP')
// Double quotes are the case under test, so Prettier leaves the next line alone.
// prettier-ignore
// ruleid: jelto-no-client-address-headers
export const cloudflare = request.headers?.get("CF-Connecting-IP")
// ruleid: jelto-no-client-address-headers
export const trueClient = request.headers.has('true-client-ip')
// ruleid: jelto-no-client-address-headers
export const forwarded = request.headers.get('Forwarded')
// ruleid: jelto-no-client-address-headers
export const nodeIndex = incoming.headers['x-forwarded-for']
// ruleid: jelto-no-client-address-headers
export const nodeProperty = incoming.headers.forwarded
// ruleid: jelto-no-client-address-headers
export const expressGet = express.get('X-Forwarded-For')
// ruleid: jelto-no-client-address-headers
export const expressHeader = express.header(`x-real-ip`)

// ok: jelto-no-client-address-headers
export const userAgent = request.headers.get('user-agent')
// ok: jelto-no-client-address-headers
export const retryAfter = response.headers.get('Retry-After')
// ok: jelto-no-client-address-headers
export const forwardedHost = incoming.headers['x-forwarded-host']
// ok: jelto-no-client-address-headers
export const planted = new Headers({ 'x-forwarded-for': 'a test sets it to prove it is ignored' })
