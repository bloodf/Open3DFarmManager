import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ciSource = readFileSync(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)
const composeSource = readFileSync(
  new URL('../../infra/app/docker-compose.yml', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>
}

type Yaml = string | Yaml[] | { [key: string]: Yaml }

/**
 * Minimal YAML reader for the workflow subset used by ci.yml: block mappings,
 * block sequences, flow sequences, quoted/plain scalars and `|` / `>-` block
 * scalars. Anything else throws, so the test fails loudly instead of guessing.
 */
function parseYamlSubset(source: string): Record<string, Yaml> {
  const lines = source.split('\n')
  let i = 0
  const at = (k: number): string => lines[k] ?? ''
  const indentOf = (line: string) => line.length - line.trimStart().length
  const isSkippable = (line: string) => /^\s*(#.*)?$/.test(line)
  const skip = () => {
    while (i < lines.length && isSkippable(at(i))) i++
  }
  const unquote = (text: string) => text.replace(/^(['"])(.*)\1$/, '$2')
  const parseScalar = (text: string): Yaml => {
    if (text.startsWith('[') && text.endsWith(']')) {
      return text
        .slice(1, -1)
        .split(',')
        .map((item) => unquote(item.trim()))
        .filter(Boolean)
    }
    return unquote(text)
  }
  const parseBlockScalar = (parentIndent: number, folded: boolean): string => {
    const body: string[] = []
    while (
      i < lines.length &&
      (at(i).trim() === '' || indentOf(at(i)) > parentIndent)
    ) {
      body.push(at(i).trim() === '' ? '' : at(i))
      i++
    }
    while (body.length && body.at(-1) === '') body.pop()
    const trimmed = body.map((line) => line.trim())
    return folded ? trimmed.join(' ') : trimmed.join('\n')
  }
  const parseBlock = (): Yaml => {
    skip()
    if (i >= lines.length) return ''
    const text = at(i).trim()
    return text === '-' || text.startsWith('- ')
      ? parseSequence(indentOf(at(i)))
      : parseMapping(indentOf(at(i)))
  }
  const parseSequence = (indent: number): Yaml[] => {
    const items: Yaml[] = []
    for (;;) {
      skip()
      if (
        i >= lines.length ||
        indentOf(at(i)) !== indent ||
        !/^-(\s|$)/.test(at(i).trim())
      )
        break
      const rest = at(i).trim().slice(1).trim()
      if (rest === '') {
        i++
        items.push(parseBlock())
      } else if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(rest)) {
        lines[i] = ' '.repeat(indent + 2) + rest
        items.push(parseMapping(indent + 2))
      } else {
        i++
        items.push(parseScalar(rest))
      }
    }
    return items
  }
  const parseMapping = (indent: number): Record<string, Yaml> => {
    const map: Record<string, Yaml> = {}
    for (;;) {
      skip()
      if (i >= lines.length) break
      const current = indentOf(at(i))
      if (current < indent) break
      const text = at(i).trim()
      if (current > indent)
        throw new Error(
          `unsupported YAML indentation at line ${i + 1}: ${text}`,
        )
      if (/^-(\s|$)/.test(text)) break
      const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text)
      if (!match) throw new Error(`unsupported YAML at line ${i + 1}: ${text}`)
      const key = match[1] ?? ''
      const rest = match[2] ?? ''
      i++
      if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
        map[key] = parseBlockScalar(indent, rest.startsWith('>'))
      } else if (rest === '') {
        skip()
        const nested =
          i < lines.length &&
          (indentOf(at(i)) > indent ||
            (indentOf(at(i)) === indent && /^-(\s|$)/.test(at(i).trim())))
        map[key] = nested ? parseBlock() : ''
      } else {
        map[key] = parseScalar(rest)
      }
    }
    return map
  }
  return parseMapping(0)
}

const workflow = parseYamlSubset(ciSource)
const jobs = workflow.jobs as Record<string, Record<string, Yaml>>
const postgresJob =
  jobs.postgres ?? assert.fail('ci.yml must define a postgres job')
const postgresService =
  (postgresJob.services as Record<string, Record<string, string>>).postgres ??
  assert.fail('postgres service must be defined')
const steps = postgresJob.steps as Array<Record<string, Yaml>>

test('Checks workflow is dispatch-only', () => {
  assert.deepEqual(workflow.on, ['workflow_dispatch'])
})

test('postgres job exists and keeps the existing checkout and setup pattern', () => {
  assert.equal(postgresJob['runs-on'], 'ubuntu-latest')
  const uses = steps.map((step) => step.uses).filter(Boolean)
  assert.deepEqual(uses, [
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  ])
})

test('postgres service image is pinned by digest and matches infra/app/docker-compose.yml', () => {
  const composeImage = /image:\s*(postgres:17@sha256:[a-f0-9]{64})/.exec(
    composeSource,
  )?.[1]
  assert.ok(composeImage, 'compose file must pin postgres:17 by digest')
  assert.equal(postgresService.image, composeImage)
  assert.match(postgresService.image, /^postgres:17@sha256:[a-f0-9]{64}$/)
})

test('postgres job runs test:postgres with bounded output and pipefail', () => {
  assert.ok(
    packageJson.scripts['test:postgres'],
    'package.json must define test:postgres',
  )
  const runs = steps.map((step) => String(step.run ?? ''))
  const command = runs.find((run) => run.includes('npm run test:postgres'))
  assert.ok(command, 'a step must run npm run test:postgres')
  assert.match(command, /set -o pipefail/)
  assert.match(command, /npm run test:postgres 2>&1 \| tail -c 200000/)
})

test('postgres job does not run on any trigger other than workflow_dispatch', () => {
  assert.equal(
    Array.isArray(workflow.on) &&
      workflow.on.length === 1 &&
      workflow.on[0] === 'workflow_dispatch',
    true,
  )
})
