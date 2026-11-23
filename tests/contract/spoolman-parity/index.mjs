// Orchestrates the comparison once the two servers are up (the container
// lifecycle belongs to scripts/test-spoolman-parity.mjs).
import { readFile } from 'node:fs/promises'
import { runHttpCorpus } from './run-http.mjs'
import { runWebsocketCorpus } from './ws.mjs'

const here = new URL('./', import.meta.url)

export async function loadAllowances() {
  return JSON.parse(
    await readFile(new URL('allowed-differences.json', here), 'utf8'),
  )
}

/**
 * Every allowance must be explained in the compatibility matrix: its `matrix`
 * fragment has to appear in docs/compatibility/spoolman-matrix.md.
 */
export async function checkAllowancesDocumented(allowances, matrixMarkdown) {
  const problems = []
  const ids = new Set()
  for (const a of allowances) {
    if (ids.has(a.id)) problems.push(`duplicate allowance ${a.id}`)
    ids.add(a.id)
    for (const key of ['id', 'corpus', 'case', 'reason', 'matrix'])
      if (typeof a[key] !== 'string' || a[key].trim() === '')
        problems.push(`allowance ${a.id ?? '?'} lacks ${key}`)
    if (a.matrix && !matrixMarkdown.includes(a.matrix))
      problems.push(
        `allowance ${a.id}: "${a.matrix}" is not documented in docs/compatibility/spoolman-matrix.md`,
      )
  }
  return problems
}

/** `pairs`: corpus name -> { upstream, builtin } targets. */
export async function runParity({
  corpora,
  pairs,
  allowances,
  log = console.log,
}) {
  const report = []
  const failures = []
  const used = new Set()
  for (const corpus of corpora) {
    const pair = pairs.get(corpus.name)
    const run =
      corpus.kind === 'websocket'
        ? await runWebsocketCorpus({ corpus, ...pair, allowances })
        : await runHttpCorpus({ corpus, ...pair, allowances })
    for (const id of run.usedAllowances) used.add(id)
    failures.push(...run.failures)
    const counts = {}
    for (const r of run.results)
      counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
    log(
      `${corpus.name}: ${run.results.length} ${corpus.kind === 'websocket' ? 'scenarios' : 'requests'} — ${JSON.stringify(counts)}`,
    )
    report.push({
      corpus: corpus.name,
      kind: corpus.kind,
      files: corpus.files.map(({ path, sha256 }) => ({ path, sha256 })),
      total: run.results.length,
      outcomes: counts,
      results: run.results,
    })
  }
  for (const a of allowances)
    if (!used.has(a.id))
      failures.push(`allowance ${a.id} (${a.corpus}/${a.case}) matched no case`)
  return { report, failures }
}
