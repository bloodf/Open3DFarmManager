export interface JsonLimits {
  maxBytes?: number
  maxDepth?: number
  maxValues?: number
  maxStringChars?: number
}
export type JsonReadErrorCode =
  | 'invalid-limits'
  | 'size-limit'
  | 'depth-limit'
  | 'value-limit'
  | 'string-limit'
  | 'duplicate-key'
  | 'invalid-unicode'
  | 'nonfinite-number'
  | 'invalid-json'
export class JsonReadError extends Error {
  readonly code: JsonReadErrorCode
  constructor(code: JsonReadErrorCode) {
    super(`JSON input rejected: ${code}`)
    this.name = 'JsonReadError'
    this.code = code
  }
}
function bounded(
  value: number | undefined,
  fallback: number,
  cap: number,
): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap)
    throw new JsonReadError('invalid-limits')
  return limit
}
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Validates ambiguity and resource limits before native decoding. Returns untrusted data. */
export function parseBoundedJson(
  source: string,
  limits: JsonLimits = {},
): unknown {
  const maxBytes = bounded(limits.maxBytes, 65_536, 1_048_576)
  const maxDepth = bounded(limits.maxDepth, 32, 64)
  const maxValues = bounded(limits.maxValues, 4096, 100_000)
  const maxStringChars = bounded(limits.maxStringChars, 16_384, 1_048_576)
  if (typeof source !== 'string') throw new JsonReadError('invalid-json')
  if (
    source.length > maxBytes ||
    new TextEncoder().encode(source).byteLength > maxBytes
  )
    throw new JsonReadError('size-limit')
  let offset = 0
  let values = 0
  const invalid = (): never => {
    throw new JsonReadError('invalid-json')
  }
  function whitespace() {
    while (
      offset < source.length &&
      [' ', '\t', '\r', '\n'].includes(source[offset]!)
    )
      offset++
  }
  function string(): string {
    if (source[offset] !== '"') return invalid()
    const start = offset++
    while (offset < source.length) {
      const char = source[offset++]!
      if (char === '"') {
        let decoded: string
        try {
          decoded = JSON.parse(source.slice(start, offset)) as string
        } catch {
          return invalid()
        }
        if (decoded.length > maxStringChars)
          throw new JsonReadError('string-limit')
        if (!validUnicode(decoded)) throw new JsonReadError('invalid-unicode')
        return decoded
      }
      if (char === '\\') {
        if (offset >= source.length) return invalid()
        // Escaped quotes cannot close this token. Native decoding validates the escape.
        offset++
      } else if (char.charCodeAt(0) < 0x20) return invalid()
    }
    return invalid()
  }
  function value(depth: number): void {
    if (depth > maxDepth) throw new JsonReadError('depth-limit')
    if (++values > maxValues) throw new JsonReadError('value-limit')
    whitespace()
    const char = source[offset]
    if (char === '"') {
      string()
      return
    }
    if (char === '{') {
      offset++
      whitespace()
      if (source[offset] === '}') {
        offset++
        return
      }
      const keys = new Set<string>()
      for (;;) {
        const key = string()
        if (keys.has(key)) throw new JsonReadError('duplicate-key')
        keys.add(key)
        whitespace()
        if (source[offset++] !== ':') return invalid()
        value(depth + 1)
        whitespace()
        const separator = source[offset++]
        if (separator === '}') return
        if (separator !== ',') return invalid()
        whitespace()
      }
    }
    if (char === '[') {
      offset++
      whitespace()
      if (source[offset] === ']') {
        offset++
        return
      }
      for (;;) {
        value(depth + 1)
        whitespace()
        const separator = source[offset++]
        if (separator === ']') return
        if (separator !== ',') return invalid()
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length
        return
      }
    }
    const numeric =
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
        source.slice(offset),
      )?.[0]
    if (!numeric) return invalid()
    if (!Number.isFinite(Number(numeric)))
      throw new JsonReadError('nonfinite-number')
    offset += numeric.length
  }
  value(1)
  whitespace()
  if (offset !== source.length) return invalid()
  // The scanner constructs no object, so __proto__ remains ordinary JSON data.
  try {
    return JSON.parse(source) as unknown
  } catch {
    return invalid()
  }
}
