/**
 * Small re-implementations of the Python and SQLite behaviour the pinned
 * Spoolman v0.27.1 filters rely on (its default database is SQLite), so the
 * legacy API answers the same question the same way.
 */

const PY_INT = /^\s*[+-]?\d(_?\d)*\s*$/
const PY_FLOAT =
  /^\s*[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?\s*$/
const PY_FLOAT_SPECIAL = /^\s*[+-]?(inf|infinity|nan)\s*$/i

/** Python `int(text)`; `null` where Python raises ValueError. */
export function pyInt(text: string): number | null {
  if (!PY_INT.test(text)) return null
  return Number(text.trim().replaceAll('_', ''))
}

/** Python `float(text)`; `null` where Python raises ValueError. */
export function pyFloat(text: string): number | null {
  const special = PY_FLOAT_SPECIAL.exec(text)
  if (special) {
    const negative = text.trim().startsWith('-')
    if (special[1]!.toLowerCase() === 'nan') return Number.NaN
    return negative ? -Infinity : Infinity
  }
  if (!PY_FLOAT.test(text)) return null
  return Number(text.trim().replaceAll('_', ''))
}

/** Python `repr()` of a str, as used in `{value!r}` messages. */
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += `\\${quote}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f)
      out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return quote + out + quote
}

/** SQLite `lower()` without ICU: ASCII letters only. */
export const asciiLower = (text: string) =>
  text.replace(/[A-Z]/g, (c) => c.toLowerCase())

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/g

/**
 * SQLite `LIKE` (ASCII case-insensitive). With `escape`, that character makes
 * the next `%`, `_` or itself literal; without it, `%` and `_` are wildcards.
 */
export function sqliteLike(
  value: string,
  pattern: string,
  escape?: string,
): boolean {
  let source = ''
  const chars = [...pattern]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (escape !== undefined && ch === escape && i + 1 < chars.length) {
      source += asciiLower(chars[++i]!).replace(REGEX_SPECIAL, '\\$&')
    } else if (ch === '%') source += '.*'
    else if (ch === '_') source += '.'
    else source += asciiLower(ch).replace(REGEX_SPECIAL, '\\$&')
  }
  return new RegExp(`^${source}$`, 'su').test(asciiLower(value))
}

/** Escape `%`, `_` and `/` for a LIKE with `ESCAPE '/'` (upstream `escape_like`). */
export const escapeLike = (value: string) =>
  value.replaceAll('/', '//').replaceAll('%', '/%').replaceAll('_', '/_')

/** SQLite `CAST(text AS INTEGER)`: longest integer prefix, else 0. */
export function sqliteCastInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  const match = /^\s*[+-]?\d+/.exec(String(value))
  return match ? Number(match[0]) : 0
}

/** SQLite `CAST(text AS REAL)`: longest real-number prefix, else 0. */
export function sqliteCastReal(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  const match = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(String(value))
  return match ? Number(match[0]) : 0
}

/**
 * Upstream `split_filter_terms`: comma-separated, a `"quoted"` term is kept
 * whole (and later matched exactly).
 */
export function splitFilterTerms(value: string): string[] {
  const terms: string[] = []
  let pos = 0
  for (;;) {
    if (value.startsWith('"', pos)) {
      const end = value.indexOf('",', pos + 1)
      if (end !== -1) {
        terms.push(value.slice(pos, end + 1))
        pos = end + 2
        continue
      }
      if (pos < value.length - 1 && value.endsWith('"')) {
        terms.push(value.slice(pos))
        return terms
      }
    }
    const comma = value.indexOf(',', pos)
    if (comma === -1) {
      terms.push(value.slice(pos))
      return terms
    }
    terms.push(value.slice(pos, comma))
    pos = comma + 1
  }
}

/** Code-point order, which is SQLite's BINARY collation over UTF-8. */
export function compareText(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (d !== 0) return d
  }
  return x.length - y.length
}

/** Upstream `datetime_to_str` for second-resolution UTC timestamps. */
export function spoolmanDateTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000)
    .toISOString()
    .replace('.000Z', 'Z')
}

/** Character count as Python `len(str)` (code points). */
export const pyLen = (text: string) => [...text].length

/** Python `repr(float)`: `150.0`, `1e-05`, shortest round-trip digits. */
export function pyFloatText(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`
  const text = String(value)
  if (!/e/.test(text)) return text
  const [mantissa = '', exponent = '0'] = text.split('e')
  const sign = exponent.startsWith('-') ? '-' : '+'
  const digits = exponent.replace(/^[-+]/, '').padStart(2, '0')
  return `${mantissa}e${sign}${digits}`
}
