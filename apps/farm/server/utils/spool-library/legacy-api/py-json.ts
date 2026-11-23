/**
 * Python `json` module behaviour that upstream answers expose: the text of a
 * `JSONDecodeError`, and `json.dumps` with its default separators and ASCII
 * escaping.
 */

const WS = new Set([' ', '\t', '\n', '\r'])
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/

class Failure {
  readonly message: string
  readonly position: number
  constructor(message: string, position: number) {
    this.message = message
    this.position = position
  }
}

function skip(text: string, at: number): number {
  let i = at
  while (WS.has(text[i] ?? '')) i++
  return i
}

function parseString(text: string, start: number): number {
  let i = start + 1
  for (;;) {
    const ch = text[i]
    if (ch === undefined)
      throw new Failure('Unterminated string starting at', start)
    if (ch === '"') return i + 1
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined)
        throw new Failure('Unterminated string starting at', start)
      if (next === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))
          throw new Failure('Invalid \\uXXXX escape', i + 1)
        i += 6
        continue
      }
      if (!'"\\/bfnrt'.includes(next)) throw new Failure('Invalid \\escape', i)
      i += 2
      continue
    }
    if (ch < ' ') throw new Failure('Invalid control character at', i)
    i++
  }
}

function parseValue(text: string, at: number): number {
  const ch = text[at]
  if (ch === '"') return parseString(text, at)
  if (ch === '{') return parseObject(text, at)
  if (ch === '[') return parseArray(text, at)
  for (const literal of [
    'null',
    'true',
    'false',
    'NaN',
    'Infinity',
    '-Infinity',
  ])
    if (text.startsWith(literal, at)) return at + literal.length
  const number = NUMBER.exec(text.slice(at))
  if (number) return at + number[0].length
  throw new Failure('Expecting value', at)
}

function parseObject(text: string, start: number): number {
  let i = skip(text, start + 1)
  if (text[i] === '}') return i + 1
  for (;;) {
    if (text[i] !== '"')
      throw new Failure('Expecting property name enclosed in double quotes', i)
    i = skip(text, parseString(text, i))
    if (text[i] !== ':') throw new Failure("Expecting ':' delimiter", i)
    i = skip(text, i + 1)
    i = skip(text, parseValue(text, i))
    if (text[i] === '}') return i + 1
    if (text[i] !== ',') throw new Failure("Expecting ',' delimiter", i)
    i = skip(text, i + 1)
  }
}

function parseArray(text: string, start: number): number {
  let i = skip(text, start + 1)
  if (text[i] === ']') return i + 1
  for (;;) {
    i = skip(text, parseValue(text, i))
    if (text[i] === ']') return i + 1
    if (text[i] !== ',') throw new Failure("Expecting ',' delimiter", i)
    i = skip(text, i + 1)
  }
}

export interface PyJsonError {
  /** `JSONDecodeError.msg`. */
  msg: string
  /** `str(JSONDecodeError)`. */
  text: string
}

/** What Python's `json.loads` raises for `text`, or null if it is valid. */
export function pyJsonDecodeError(text: string): PyJsonError | null {
  try {
    const start = skip(text, 0)
    const end = skip(text, parseValue(text, start))
    if (end !== text.length) throw new Failure('Extra data', end)
    return null
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    const before = text.slice(0, error.position)
    const line = before.split('\n').length
    const column = error.position - (before.lastIndexOf('\n') + 1) + 1
    return {
      msg: error.message,
      text: `${error.message}: line ${line} column ${column} (char ${error.position})`,
    }
  }
}

const escapeChar = (ch: string): string => {
  const code = ch.charCodeAt(0)
  const named: Record<string, string> = {
    '"': '\\"',
    '\\': '\\\\',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\b': '\\b',
    '\f': '\\f',
  }
  return named[ch] ?? `\\u${code.toString(16).padStart(4, '0')}`
}

/** `json.dumps(value)`: `, ` and `: ` separators, non-ASCII escaped. */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string')
    return `"${value.replace(/["\\\u0000-\u001f\u007f-￿]/g, escapeChar)}"`
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>)
  return `{${entries
    .map(([key, inner]) => `${pyJsonDumps(key)}: ${pyJsonDumps(inner)}`)
    .join(', ')}}`
}
