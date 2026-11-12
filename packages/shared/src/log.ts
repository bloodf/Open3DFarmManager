// Regexes use bounded quantifiers so scrubbing stays linear on hostile input.
// Pairing code wire field is `user_code`; `admission_nonce`/nonces are redacted,
// `challenge_id` is a public correlation id and is kept.
const SENSITIVE_KEY =
  /pass|pwd|secret|token|cookie|authorization|credential|private.?key|api.?key|signature|signing.?key|proof|user.?code|pairing.?code|nonce|session|verifier|csrf|hmac|jwt|database.?url|dsn|connection.?string|mnemonic|(^|[_-])otp/i
// Exact (lowercased) keys: private JWK members and short names too broad for a regex.
const SENSITIVE_EXACT = new Set([
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'k',
  'sig',
  'pw',
  'otp',
  'totp',
  'hotp',
  'salt',
  'seed',
])
const QUERY_KEY =
  'token|code|secret|pass|sig|key|nonce|proof|session|credential'
const TEXT_KEY =
  'password|passwd|pwd|secret|token|api[_-]?key|cookie|session[_-]?id|authorization'
const SCRUBBERS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED]',
  ],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[REDACTED]'],
  [/([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@]{0,256}@/gi, '$1[REDACTED]@'],
  [
    new RegExp(
      `([?&;])([^=&\\s#]{0,64}(?:${QUERY_KEY})[^=&\\s#]{0,64})=[^&\\s#]*`,
      'gi',
    ),
    '$1$2=[REDACTED]',
  ],
  [
    new RegExp(
      `\\b([\\w-]{0,40}(?:${TEXT_KEY})[\\w-]{0,40})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"']+)`,
      'gi',
    ),
    '$1$2[REDACTED]',
  ],
  [/\bBearer\s+[\w.~+/=-]+/gi, '[REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g, '[REDACTED]'],
]
const REDACTED = '[REDACTED]'
const MAX_INPUT = 65536
const MAX_STRING = 512
const MAX_DEPTH = 6
const MAX_ENTRIES = 50
const MAX_NODES = 1000
const MAX_ERRORS = 10

export type LogLevel = 'info' | 'warn' | 'error'

function scrub(text: string): string {
  let out = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text
  for (const [pattern, replacement] of SCRUBBERS)
    out = out.replace(pattern, replacement)
  return out.length > MAX_STRING
    ? `${out.slice(0, MAX_STRING)}...[truncated]`
    : out
}

/** Reads a data property along the prototype chain; never invokes getters or traps beyond descriptors. */
function read(obj: object, key: string): unknown {
  for (
    let o: object | null = obj, i = 0;
    o && i < 8;
    o = Object.getPrototypeOf(o), i++
  ) {
    const desc = Object.getOwnPropertyDescriptor(o, key)
    if (!desc) continue
    if ('value' in desc) return desc.value
    // V8 exposes Error.stack as a native accessor; user-defined getters are never invoked.
    if (
      key === 'stack' &&
      desc.get &&
      /\[native code\]/.test(Function.prototype.toString.call(desc.get))
    ) {
      return desc.get.call(obj)
    }
    return undefined
  }
  return undefined
}

interface Budget {
  nodes: number
}

function node(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: Budget,
): unknown {
  if (typeof value === 'string') return scrub(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol'
      ? undefined
      : value
  }
  if (budget.nodes-- <= 0) return '[Budget]'
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[MaxDepth]'
  seen.add(value)
  try {
    return objectNode(value, depth, seen, budget)
  } catch {
    return '[Unreadable]'
  }
}

function objectNode(
  value: object,
  depth: number,
  seen: WeakSet<object>,
  budget: Budget,
): unknown {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[Binary ${(value as ArrayBuffer).byteLength}B]`
  }
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof Map) return `[Map ${value.size}]`
  if (value instanceof Set) return `[Set ${value.size}]`
  if (value instanceof Error) {
    const out: Record<string, unknown> = Object.create(null)
    const name = read(value, 'name')
    const message = read(value, 'message')
    const stack = read(value, 'stack')
    const code = read(value, 'code')
    const statusCode = read(value, 'statusCode')
    const cause = read(value, 'cause')
    const errors = read(value, 'errors')
    if (typeof name === 'string') out.name = scrub(name)
    if (typeof message === 'string') out.message = scrub(message)
    if (typeof stack === 'string') out.stack = scrub(stack)
    if (typeof code === 'string') out.code = scrub(code)
    if (typeof statusCode === 'number') out.statusCode = statusCode
    if (cause !== undefined) out.cause = node(cause, depth + 1, seen, budget)
    if (value instanceof AggregateError && Array.isArray(errors)) {
      out.errors = errors
        .slice(0, MAX_ERRORS)
        .map((e) => node(e, depth + 1, seen, budget))
    }
    return out
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (let i = 0; i < value.length && i < MAX_ENTRIES; i++) {
      out.push(node(read(value, String(i)), depth + 1, seen, budget))
    }
    return out
  }
  const out: Record<string, unknown> = Object.create(null)
  let count = 0
  // for-in with a counter: never materializes the key list of a huge object.
  for (const key in value) {
    if (count++ >= MAX_ENTRIES) break
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (!desc) continue
    out[key] =
      SENSITIVE_KEY.test(key) || SENSITIVE_EXACT.has(key.toLowerCase())
        ? REDACTED
        : 'value' in desc
          ? node(desc.value, depth + 1, seen, budget)
          : '[Getter]'
  }
  return out
}

/** Returns a JSON-safe copy with secrets masked and size/node counts bounded. */
export function redact(value: unknown): unknown {
  return node(value, 0, new WeakSet<object>(), { nodes: MAX_NODES })
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

/** JSON-line logger; every entry passes through redact(). Never throws. */
export function createLogger(
  name: string,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown> = {},
  ) => {
    try {
      write(
        JSON.stringify({
          ...(redact(fields) as object),
          ts: now().toISOString(),
          level,
          name,
          msg: scrub(msg),
        }),
      )
    } catch {
      try {
        write(JSON.stringify({ level, name, msg: 'log-failed' }))
      } catch {
        // logging must never break the caller
      }
    }
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  }
}
