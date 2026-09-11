// Parse property arguments as JSON objects. Leave property names, lengths,
// and values for the SDK to validate so conformance can observe its rejections.

export type PropValue = string | number | boolean

export type ParsedProps =
  | { ok: true; props: Record<string, PropValue> | undefined }
  | { ok: false; error: string }

/**
 * Parses the token at `at`, if there is one. An absent or blank token is not an
 * error and is not an empty object either: it means the command carried no
 * props, exactly as `refhost`'s `parseProps` returns a nil map for it.
 */
export function parseProps(tokens: readonly string[], at: number): ParsedProps {
  const raw = tokens[at]
  if (raw === undefined || raw.trim() === '') {
    return { ok: true, props: undefined }
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `props must be a JSON object: ${messageOf(err)}` }
  }

  // `null` decodes into an absent map in Go too (`json.Unmarshal` of `null`
  // into a map leaves it nil and reports no error), so it is "no props" and
  // not a refusal.
  if (decoded === null) {
    return { ok: true, props: undefined }
  }
  if (typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { ok: false, error: 'props must be a JSON object' }
  }

  const props: Record<string, PropValue> = {}
  for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      props[key] = value
    }
    // A `null`, a nested object and an array are skipped rather than refused,
    // consistent with how other conformance hosts treat them: the
    // install-property dictionary has no representation for any of the three,
    // so there is no call the host could make that would carry one to the SDK.
    // No scenario sends one.
  }
  return { ok: true, props }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
