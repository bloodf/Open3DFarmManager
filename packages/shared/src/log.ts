const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|cookie|authorization|credential|private.?key|api.?key|signature|proof|pairing.?code|nonce/i
const SENSITIVE_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
]
const REDACTED = '[REDACTED]'
const MAX_STRING = 512
const MAX_DEPTH = 6
const MAX_ENTRIES = 50

export type LogLevel = 'info' | 'warn' | 'error'

function scrub(text: string): string {
  let out = text
  for (const pattern of SENSITIVE_TEXT) out = out.replace(pattern, REDACTED)
  return out.length > MAX_STRING
    ? `${out.slice(0, MAX_STRING)}...[truncated]`
    : out
}

/** Returns a JSON-safe copy with secrets masked and field sizes bounded. */
export function redact(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return scrub(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol'
      ? undefined
      : value
  }
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[MaxDepth]'
  seen.add(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrub(value.message),
      stack: value.stack ? scrub(value.stack) : undefined,
      cause:
        value.cause === undefined
          ? undefined
          : redact(value.cause, depth + 1, seen),
      ...(redact({ ...value }, depth + 1, seen) as object),
    }
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ENTRIES)
      .map((item) => redact(item, depth + 1, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    out[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : redact(item, depth + 1, seen)
  }
  return out
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

/** JSON-line logger; every entry passes through redact(). */
export function createLogger(
  name: string,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown> = {},
  ) =>
    write(
      JSON.stringify({
        ...(redact(fields) as object),
        ts: now().toISOString(),
        level,
        name,
        msg: scrub(msg),
      }),
    )
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  }
}
