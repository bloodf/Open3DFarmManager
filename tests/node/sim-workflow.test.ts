import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const simSource = readFileSync(
  new URL('../../.github/workflows/sim.yml', import.meta.url),
  'utf8',
)
const evidenceSource = readFileSync(
  new URL('../../docs/SIMULATOR-EVIDENCE-SUMMARY.md', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>
}

type Yaml = string | Yaml[] | { [key: string]: Yaml }

/**
 * Minimal YAML reader for the workflow subset used by sim.yml: block mappings,
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

const workflow = parseYamlSubset(simSource)
const jobs = workflow.jobs as Record<string, Record<string, Yaml>>

const PROFILE_JOBS = ['mock', 'klipper', 'spoolman', 'cams', 'rtsp'] as const

function matrixInclude(job: Record<string, Yaml>) {
  const strategy = job.strategy as Record<string, Yaml>
  const matrix = strategy.matrix as Record<string, Yaml>
  return matrix.include as Array<Record<string, string>>
}

function stepsOf(job: Record<string, Yaml>) {
  return job.steps as Array<Record<string, Yaml>>
}

function runText(step: Record<string, Yaml>): string {
  return String(step.run ?? '')
}

test('Simulator workflow is dispatch-only', () => {
  assert.deepEqual(workflow.on, ['workflow_dispatch'])
  assert.equal(
    Array.isArray(workflow.on) &&
      workflow.on.length === 1 &&
      workflow.on[0] === 'workflow_dispatch',
    true,
  )
  assert.doesNotMatch(simSource, /\bon:\s*\n?\s*pull_request\b/)
  assert.doesNotMatch(simSource, /\bpush:\s/)
})

test('all simulator jobs matrix amd64 and arm64 runners', () => {
  for (const name of PROFILE_JOBS) {
    const job = jobs[name] ?? assert.fail(`sim.yml must define ${name}`)
    assert.equal(job['runs-on'], '${{ matrix.runner }}')
    const include = matrixInclude(job)
    assert.deepEqual(
      include.map((row) => ({ arch: row.arch, runner: row.runner })),
      [
        { arch: 'amd64', runner: 'ubuntu-24.04' },
        { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
      ],
    )
  }
})

test('each profile has a pass/fail verify step and bounded failure artifact', () => {
  assert.ok(packageJson.scripts['sim:seed'])
  assert.ok(packageJson.scripts['sim:verify:rtsp'])
  assert.equal(packageJson.scripts['sim:verify:spoolman'], undefined)
  assert.equal(packageJson.scripts['sim:verify:cams'], undefined)

  const expectedVerify: Record<(typeof PROFILE_JOBS)[number], RegExp> = {
    mock: /node --test tests\/node\/e16-358\.test\.mjs/,
    klipper: /npm run sim:smoke/,
    spoolman:
      /npm run sim:seed[\s\S]*node packages\/sim-tools\/src\/spoolman-cli\.ts/,
    cams: /node packages\/sim-tools\/src\/camera-cli\.ts/,
    rtsp: /npm run sim:verify:rtsp/,
  }

  for (const name of PROFILE_JOBS) {
    const job = jobs[name] ?? assert.fail(`missing ${name}`)
    const steps = stepsOf(job)
    const verify = steps.find((step) =>
      expectedVerify[name].test(runText(step)),
    )
    assert.ok(verify, `${name} must have a pass/fail verify step`)
    if (name !== 'klipper') assert.match(runText(verify), /tail -c 200000/)
    if (name === 'spoolman' || name === 'cams' || name === 'rtsp') {
      const diagnostic = steps.find(
        (step) =>
          step.if === 'failure()' &&
          /sim-profile-diagnostics\.mjs/.test(runText(step)),
      )
      assert.ok(diagnostic, `${name} must collect diagnostics on failure`)
      assert.match(
        runText(diagnostic),
        new RegExp(
          `sim-profile-diagnostics\\.mjs ${name} sim-diagnostics/${name}-`,
        ),
      )
    }
    const upload = steps.find(
      (step) =>
        step.if === 'failure()' &&
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/upload-artifact@'),
    )
    assert.ok(upload, `${name} must upload an artifact on failure`)
    const withBlock = upload.with as Record<string, string>
    assert.equal(withBlock.path, 'sim-diagnostics/')
    assert.equal(withBlock['retention-days'], '7')
    assert.equal(withBlock['if-no-files-found'], 'ignore')
    const artifactName = withBlock.name
    assert.ok(artifactName, `${name} artifact must have a name`)
    assert.match(artifactName, new RegExp(`^sim-${name}-`))
  }
})

test('evidence summary leaves architecture links pending owner dispatch', () => {
  assert.match(
    evidenceSource,
    /amd64 \(`ubuntu-24\.04`\): pending: owner dispatch/,
  )
  assert.match(
    evidenceSource,
    /arm64 \(`ubuntu-24\.04-arm`\): pending: owner dispatch/,
  )
})

test('Spoolman selects its pinned multi-platform image natively', () => {
  const compose = readFileSync(
    new URL('../../infra/sim/docker-compose.yml', import.meta.url),
    'utf8',
  )
  const spoolman =
    compose.split('  spoolman:\n')[1]?.split('  camera:\n')[0] ?? ''
  assert.match(
    spoolman,
    /image: ghcr\.io\/donkie\/spoolman@sha256:1ebb4f6a62c2e72a07f18b07ebfdbd96322f5bc2eb72570af3088f68d7c393b1/,
  )
  assert.doesNotMatch(spoolman, /platform:/)
})
