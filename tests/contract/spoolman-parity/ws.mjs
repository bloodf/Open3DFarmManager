// Websocket parity: the same HTTP changes are made on both servers while
// clients listen on the same upstream feed paths; the event streams are
// compared (type, resource, payload; the date is normalised). Handshake
// refusals are compared by close code.
import { isDeepStrictEqual } from 'node:util'
import WebSocket from 'ws'
import { normalizeValue, send } from './compare.mjs'

function openFeed(target, path, headers = {}, send = undefined) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${target.wsUrl}${target.prefix}${path}`, {
      headers,
    })
    const events = []
    const state = { events, close: undefined, refused: undefined }
    socket.on('message', (data) => {
      try {
        events.push(JSON.parse(data.toString()))
      } catch {
        events.push({ unparsable: data.toString() })
      }
    })
    socket.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString() }
    })
    socket.on('unexpected-response', (_req, res) => {
      state.refused = res.statusCode
      res.resume()
      resolve({ ...state, socket, ready: false })
    })
    socket.on('error', () => {})
    socket.on('open', () => {
      if (send !== undefined) socket.send(send)
      resolve({ ...state, socket, ready: true, state })
    })
    state.socket = socket
  })
}

/**
 * Record ids differ by design between the servers (Spoolman reuses the id of
 * a deleted highest row, the built-in server never does), so ids are replaced
 * by their order of first appearance per resource within one scenario.
 */
const newIdState = () => ({
  vendor: new Map(),
  filament: new Map(),
  spool: new Map(),
})

function normalizeIds(events, seen) {
  const label = (kind, id) => {
    if (typeof id !== 'number') return id
    const map = seen[kind]
    if (!map.has(id)) map.set(id, map.size + 1)
    return `<${kind} #${map.get(id)}>`
  }
  const walk = (value, kind) => {
    if (Array.isArray(value)) return value.map((item) => walk(item, kind))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        if (key === 'id' && kind) return [key, label(kind, inner)]
        if (key === 'vendor_id') return [key, label('vendor', inner)]
        if (key === 'filament_id') return [key, label('filament', inner)]
        if (key === 'vendor' || key === 'filament' || key === 'spool')
          return [key, walk(inner, key)]
        return [key, walk(inner, kind === undefined ? undefined : null)]
      }),
    )
  }
  return events.map((event) => ({
    ...event,
    payload: walk(event.payload, event.resource),
  }))
}

const settle = (ms) => new Promise((done) => setTimeout(done, ms))

function substitute(value, vars) {
  if (typeof value === 'string') {
    const whole = /^\$\{(\w+)\}$/.exec(value)
    if (whole) return vars[whole[1]]
    return value.replace(/\$\{(\w+)\}/g, (_, key) => String(vars[key]))
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]),
    )
  return value
}

/**
 * Run one scenario on one target; returns what each client heard. A step may
 * `save` response fields (`{ name: "id" }`) for `${name}` in later paths,
 * bodies and listener paths; a listener opens before the first step unless it
 * has `openAfter` (a step index).
 */
async function play(target, scenario) {
  const vars = { host: new URL(target.baseUrl).host }
  const feeds = []
  const openListeners = async (after) => {
    for (const listener of scenario.listeners) {
      if ((listener.openAfter ?? -1) !== after) continue
      const feed = await openFeed(
        target,
        substitute(listener.path, vars),
        substitute(listener.headers ?? {}, vars),
        listener.send,
      )
      feeds.push({ listener, feed })
    }
  }
  await openListeners(-1)
  const answers = []
  for (const [index, raw] of scenario.steps.entries()) {
    const step = substitute(raw, vars)
    const answer = await send(target, step)
    answers.push(answer)
    for (const [name, key] of Object.entries(raw.save ?? {}))
      vars[name] = answer.body?.[key]
    // Events are sent after the change commits; keep order deterministic.
    await settle(scenario.pauseMs ?? 80)
    await openListeners(index)
  }
  await settle(scenario.settleMs ?? 400)
  const ids = newIdState()
  const heard = feeds.map(({ listener, feed }) => ({
    path: listener.path,
    ready: feed.ready,
    refused: feed.refused ?? null,
    close: feed.state?.close ? { code: feed.state.close.code } : null,
    events: normalizeIds(
      (feed.state?.events ?? feed.events).map((e) => normalizeValue(e)),
      ids,
    ),
  }))
  for (const { feed } of feeds) feed.socket.terminate()
  await settle(50)
  return {
    statuses: answers.map((a) => a.status),
    heard: heard.map((h) => ({
      ...h,
      // 1005/1006 are the client's own termination, not a server decision.
      close:
        h.close && h.close.code !== 1005 && h.close.code !== 1006
          ? h.close
          : null,
    })),
  }
}

const SHOWN = Number(process.env.SPOOLMAN_PARITY_DIFF_CHARS ?? 600)
const show = (value) => JSON.stringify(value)?.slice(0, SHOWN)

/** Human-readable differences between what two servers sent to the listeners. */
function describe(up, bi) {
  const lines = []
  if (!isDeepStrictEqual(up.statuses, bi.statuses))
    lines.push(`HTTP statuses ${show(up.statuses)} vs ${show(bi.statuses)}`)
  for (const [index, a] of up.heard.entries()) {
    const b = bi.heard[index]
    if (isDeepStrictEqual(a, b)) continue
    const head = `listener ${a.path} #${index}`
    for (const key of ['ready', 'refused', 'close'])
      if (!isDeepStrictEqual(a[key], b[key]))
        lines.push(
          `${head}: ${key} ${show(a[key])} (Spoolman) vs ${show(b[key])}`,
        )
    const count = Math.max(a.events.length, b.events.length)
    for (let i = 0; i < count; i++)
      if (!isDeepStrictEqual(a.events[i], b.events[i])) {
        lines.push(
          `${head}: event ${i} of ${a.events.length}/${b.events.length}\n      Spoolman: ${show(a.events[i])}\n      built-in: ${show(b.events[i])}`,
        )
        break
      }
  }
  return lines.join('\n    ')
}

/**
 * Apply what an allowance explains: listeners it names are not compared,
 * events only the built-in server sends are dropped (and must exist), and
 * a handshake Spoolman refuses counts as refused however the built-in server
 * says no (HTTP status, or accept and close 4403/4400).
 */
function applyAllowance(allowance, up, bi, problems) {
  const ignore = allowance.ignoreListeners ?? []
  const extra = allowance.builtinExtraEvents ?? []
  const refusal = allowance.refusalsEquivalent === true
  const dropExtra = (heard) => {
    const events = heard.events.filter(
      (e) => !extra.some((x) => x.type === e.type && x.resource === e.resource),
    )
    return {
      removed: heard.events.length - events.length,
      heard: { ...heard, events },
    }
  }
  const refused = (h) =>
    h.refused !== null || (h.close && [4400, 4403].includes(h.close.code))
  const view = (side, isBuiltin) => {
    let removed = 0
    const heard = side.heard
      .filter((h) => !ignore.includes(h.path))
      .map((h) => {
        let out = h
        if (isBuiltin && extra.length) {
          const dropped = dropExtra(h)
          removed += dropped.removed
          out = dropped.heard
        }
        if (refusal && refused(out))
          out = { ...out, ready: false, refused: 'refused', close: null }
        return out
      })
    return [{ ...side, heard }, removed]
  }
  const [a] = view(up, false)
  const [b, removed] = view(bi, true)
  if (extra.length && removed === 0)
    problems.push(
      `allowance ${allowance.id}: the built-in server sent none of its extra events`,
    )
  return [a, b]
}

export async function runWebsocketCorpus({
  corpus,
  upstream,
  builtin,
  allowances,
}) {
  const results = []
  const failures = []
  const used = new Set()
  for (const scenario of corpus.scenarios) {
    const label = `${corpus.name}/${scenario.name}`
    let up
    let bi
    try {
      up = await play(upstream, scenario)
      bi = await play(builtin, scenario)
    } catch (error) {
      failures.push(`${label}: ${error.stack ?? error.message}`)
      results.push({ name: scenario.name, outcome: 'error' })
      continue
    }
    const allowance = allowances.find(
      (a) => a.corpus === corpus.name && a.case === scenario.name,
    )
    const same = isDeepStrictEqual(up, bi)
    let outcome = 'identical'
    const problems = []
    if (allowance) {
      used.add(allowance.id)
      if (same) problems.push(`allowance ${allowance.id} is stale`)
      const [a, b] = applyAllowance(allowance, up, bi, problems)
      if (!isDeepStrictEqual(a, b))
        problems.push(
          `still differs beyond allowance ${allowance.id}\n    ${describe(a, b)}`,
        )
      outcome = `explained:${allowance.id}`
    } else if (!same) {
      problems.push(`event streams differ\n    ${describe(up, bi)}`)
    }
    if (problems.length) {
      outcome = 'DIFFERENT'
      failures.push(`${label}\n    ${problems.join('\n    ')}`)
    }
    results.push({
      name: scenario.name,
      listeners: scenario.listeners.length,
      events: up.heard.reduce((n, h) => n + h.events.length, 0),
      outcome,
    })
  }
  return { results, failures, usedAllowances: used }
}
