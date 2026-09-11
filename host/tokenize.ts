// Tokenize the shared host command language:
// - spaces and tabs separate tokens;
// - a leading quote delimits a quoted token with backslash escapes;
// - a leading { or [ consumes the trimmed remainder as one JSON token.
// Non-leading braces remain part of ordinary tokens. ASCII delimiters have the
// same boundaries in UTF-16 as in the Swift and Go hosts.

export function tokenize(line: string): string[] {
  const tokens: string[] = []
  const n = line.length
  let i = 0

  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) {
      i++
    }
    if (i >= n) {
      break
    }

    const opener = line[i]
    if (opener === '"') {
      i++
      let token = ''
      while (i < n && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < n) {
          i++
        }
        token += line[i]
        i++
      }
      i++ // the closing quote, if there was one
      tokens.push(token)
    } else if (opener === '{' || opener === '[') {
      tokens.push(line.slice(i).trim())
      return tokens
    } else {
      const start = i
      while (i < n && line[i] !== ' ' && line[i] !== '\t') {
        i++
      }
      tokens.push(line.slice(start, i))
    }
  }

  return tokens
}
