import { isDeepStrictEqual } from 'node:util'
import { checkExpectation, diff, normalizeValue, send } from './compare.mjs'

/** Both servers sync the loopback fixture library in the background. */
async function waitForExternal(target) {
  const deadline = Date.now() + 60_000
  for (;;) {
    const answer = await send(target, {
      method: 'GET',
      path: '/api/v1/external/material',
    })
    if (answer.status === 200) return
    if (Date.now() > deadline)
      throw new Error(`external library never synced (${answer.status})`)
    await new Promise((done) => setTimeout(done, 500))
  }
}

/**
 * Replay `requests` in order against both targets.
 * Returns `{ results, failures, usedAllowances }`.
 */
export async function runHttpCorpus({
  corpus,
  upstream,
  builtin,
  allowances,
  recordedAdapter = (item) => item.recorded,
}) {
  const results = []
  const failures = []
  const used = new Set()
  for (const request of corpus.requests) {
    const label = `${corpus.name}/${request.name}`
    let up
    let bi
    try {
      if (request.waitForExternal)
        for (const target of [upstream, builtin]) await waitForExternal(target)
      up = await send(upstream, request)
      bi = await send(builtin, request)
    } catch (error) {
      failures.push(`${label}: request failed: ${error.message}`)
      results.push({ name: request.name, outcome: 'error' })
      continue
    }
    const allowance = allowances.find(
      (a) => a.corpus === corpus.name && a.case === request.name,
    )
    const strict = diff(request, up, bi, undefined)
    let problems = []
    let outcome = 'identical'
    if (allowance) {
      used.add(allowance.id)
      if (strict.length === 0)
        problems.push(
          `allowance ${allowance.id} is stale: the answers are identical`,
        )
      problems = [
        ...problems,
        ...diff(request, up, bi, allowance),
        ...checkExpectation(allowance, bi),
      ]
      if (
        allowance.upstreamStatus !== undefined &&
        allowance.upstreamStatus !== up.status
      )
        problems.push(
          `allowance ${allowance.id}: Spoolman status ${up.status}, expected ${allowance.upstreamStatus}`,
        )
      outcome = `explained:${allowance.id}`
    } else {
      problems = strict
    }
    const recorded = recordedAdapter(request)
    if (recorded) {
      if (recorded.status !== up.status)
        problems.push(
          `recorded fixture drift: status ${recorded.status} vs live Spoolman ${up.status}`,
        )
      else if (
        request.compare !== 'status-type' &&
        !isDeepStrictEqual(
          normalizeValue(recorded.response),
          normalizeValue(up.body),
        )
      )
        problems.push('recorded fixture drift: body differs from live Spoolman')
    }
    if (problems.length) {
      outcome = 'DIFFERENT'
      failures.push(
        `${label} [${request.method} ${request.path}]\n    ${problems.join('\n    ')}`,
      )
    }
    results.push({
      name: request.name,
      method: request.method,
      path: request.path,
      spoolmanStatus: up.status,
      builtinStatus: bi.status,
      outcome,
    })
  }
  return { results, failures, usedAllowances: used }
}
