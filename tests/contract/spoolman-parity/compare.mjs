// Normalisation and comparison of one request answered by both servers.
//
// Allowed differences are exactly: record ids are NOT normalised (both servers
// start empty and allocate in the same order, so ids must agree), server-clock
// timestamps are, and every entry of allowed-differences.json (each cited in
// docs/compatibility/spoolman-matrix.md). Anything else is a difference.
import { isDeepStrictEqual } from 'node:util'

/** Characters of each body shown in a failure (SPOOLMAN_PARITY_DIFF_CHARS). */
const SHOWN = Number(process.env.SPOOLMAN_PARITY_DIFF_CHARS ?? 600)
const ISO_Z = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)?$/
const COMPARED_HEADERS = [
  'content-type',
  'x-total-count',
  'x-total-spools',
  'x-total-remaining-weight',
  'content-disposition',
]

/** Server-clock fields only; dates a client sent (before 2025) stay exact. */
export function normalizeValue(value, key = null) {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizeValue(v, k)]),
    )
  if (typeof value === 'string' && ISO_Z.test(value)) {
    // Exports flatten nested records into dotted keys (filament.registered).
    if (key !== null && /(^|\.)(registered|date|created)$/.test(key))
      return '<timestamp>'
    if (
      (key === 'first_used' ||
        key === 'last_used' ||
        /\.(first|last)_used$/.test(key ?? '')) &&
      value >= '2025-01-01'
    )
      return '<timestamp>'
  }
  return value
}

/** Key order (apart from free-form `extra`) is part of the contract. */
export function keyOrder(value, parentKey = null) {
  if (parentKey === 'extra') return null
  if (Array.isArray(value)) return value.map((item) => keyOrder(item))
  if (value && typeof value === 'object')
    return Object.entries(value).map(([k, v]) => [k, keyOrder(v, k)])
  return null
}

function drop(value, path) {
  // path: dotted keys from the body root, `[]` descends into every array item.
  const [head, ...rest] = path
  if (Array.isArray(value) && head === '[]')
    return value.map((item) => drop(item, rest))
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (!(head in value)) return value
  const copy = { ...value }
  if (rest.length === 0) delete copy[head]
  else copy[head] = drop(copy[head], rest)
  return copy
}

export function applyIgnore(body, ignorePaths = []) {
  let out = body
  for (const p of ignorePaths) out = drop(out, p.split('.'))
  return out
}

function subset(expected, actual) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected))
    return (
      actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([k, v]) => subset(v, actual[k]))
    )
  return isDeepStrictEqual(expected, actual)
}

function parse(text, contentType) {
  if (/json/i.test(contentType ?? '')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

export async function send(target, request, fetchImpl = fetch) {
  const host = new URL(target.baseUrl).host
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([k, v]) => [
      k,
      String(v).replaceAll('${host}', host),
    ]),
  )
  const raw =
    request.rawBody ??
    (request.body === undefined || request.body === null
      ? undefined
      : JSON.stringify(request.body))
  if (raw !== undefined)
    headers['Content-Type'] = request.contentType ?? 'application/json'
  const response = await fetchImpl(
    `${target.baseUrl}${target.prefix}${request.path}`,
    {
      method: request.method,
      headers,
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    },
  )
  const text = await response.text()
  const contentType = response.headers.get('content-type')
  return {
    status: response.status,
    headers: Object.fromEntries(
      COMPARED_HEADERS.map((name) => [name, response.headers.get(name)]),
    ),
    text,
    body: parse(text, contentType),
  }
}

function textNormalizer(request) {
  return (text) =>
    (request.normalizeText ?? []).reduce(
      (acc, rule) => acc.replace(new RegExp(rule.pattern, 'g'), rule.with),
      text,
    )
}

/**
 * Returns the list of differences between the two answers (empty = identical),
 * after the request's own `ignorePaths`/`normalizeText` and a matching
 * allowance have been applied. `allowance` (if any) is reported by the caller.
 */
export function diff(request, upstream, builtin, allowance) {
  const problems = []
  const ignore = [
    ...(request.ignorePaths ?? []),
    ...(allowance?.ignorePaths ?? []),
  ]
  const ignoreHeaders = allowance?.ignoreHeaders ?? []
  if (upstream.status !== builtin.status && !allowance?.status)
    problems.push(`status ${upstream.status} (Spoolman) vs ${builtin.status}`)
  for (const name of COMPARED_HEADERS) {
    if (ignoreHeaders.includes(name)) continue
    const a = upstream.headers[name]
    const b = builtin.headers[name]
    // JSON charset suffix is a framework detail, not a contract.
    const clean = (v) => (v ? v.replace(/;\s*charset=utf-8$/i, '') : v)
    if (clean(a) !== clean(b))
      problems.push(
        `header ${name}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
      )
  }
  const strip = (answer) => {
    // Validation texts of one recorded case are compared by error type only.
    if (request.compare === 'status-type')
      return { type: answer.body?.detail?.[0]?.type }
    const body =
      typeof answer.body === 'string'
        ? textNormalizer(request)(answer.body)
        : normalizeValue(applyIgnore(answer.body, ignore))
    return body
  }
  const a = strip(upstream)
  const b = strip(builtin)
  if (allowance?.ignoreBody) return problems
  if (!isDeepStrictEqual(a, b))
    problems.push(
      `body differs\n  Spoolman: ${JSON.stringify(a).slice(0, SHOWN)}\n  built-in: ${JSON.stringify(b).slice(0, SHOWN)}`,
    )
  else if (
    request.compare !== 'status-type' &&
    typeof a === 'object' &&
    a !== null &&
    !isDeepStrictEqual(
      keyOrder(applyIgnore(upstream.body, ignore)),
      keyOrder(applyIgnore(builtin.body, ignore)),
    )
  )
    problems.push('key order differs')
  return problems
}

/** Check an allowance's own claim about what the built-in server answers. */
export function checkExpectation(allowance, builtin) {
  const expect = allowance.expect
  if (!expect) return []
  const problems = []
  if (expect.status !== undefined && expect.status !== builtin.status)
    problems.push(
      `allowance ${allowance.id}: built-in status ${builtin.status}, expected ${expect.status}`,
    )
  if (expect.upstreamStatus !== undefined && expect.upstreamStatus !== null) {
    // checked by the caller (needs the Spoolman answer)
  }
  if (expect.body !== undefined && !subset(expect.body, builtin.body))
    problems.push(
      `allowance ${allowance.id}: built-in body does not contain ${JSON.stringify(expect.body)}`,
    )
  return problems
}
