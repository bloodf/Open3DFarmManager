import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

type Value = string | Value[] | { [key: string]: Value }
type Mapping = { [key: string]: Value }

function ignorePatterns(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function excludesPath(patterns: string[], target: string): boolean {
  const normalized = target.replace(/\/+$/, '')
  return patterns.some((pattern) => {
    const candidate = pattern.replace(/\/+$/, '')
    return (
      candidate === normalized ||
      candidate === `/${normalized}` ||
      candidate === `${normalized}/**` ||
      candidate === `**/${normalized}` ||
      candidate === `**/${normalized}/**`
    )
  })
}

// Parse the compose file's YAML subset without Docker or installed dependencies.
function parseCompose(source: string): Mapping {
  const cleaned = source.replace(/: !\w+[ \t]*/g, ': ')
  const lines = cleaned.split('\n').filter((line) => !/^\s*(#|$)/.test(line))
  const anchors: Record<string, Mapping> = {}
  let index = 0
  const indent = (line: string) => line.length - line.trimStart().length
  function scalar(value: string): Value {
    if (/^\[[^\[\]{}]*\]$/.test(value)) {
      return value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    }
    if (/^'[^']*'$/.test(value)) return value.slice(1, -1)
    assert.match(value, /^[\w./,:@$*{}=?+-]+$/, `unsupported scalar: ${value}`)
    return value
  }
  function block(level: number): Value {
    const sequence = lines[index]?.trimStart().startsWith('- ')
    const result: Mapping | Value[] = sequence ? [] : {}
    while (index < lines.length && indent(lines[index]!) === level) {
      const text = lines[index]!.trim()
      index++
      if (sequence) {
        assert.ok(text.startsWith('- '), `unsupported sequence: ${text}`)
        ;(result as Value[]).push(scalar(text.slice(2)))
        continue
      }
      const match = /^(<<|[\w.-]+):(?:\s+(.*))?$/.exec(text)
      assert.ok(match, `unsupported mapping: ${text}`)
      const [, key, rest = ''] = match
      assert.ok(key)
      if (key === '<<') {
        assert.match(rest, /^\*\w+$/)
        const anchor = anchors[rest.slice(1)]
        assert.ok(anchor, `unknown anchor: ${rest}`)
        Object.assign(result, structuredClone(anchor))
      } else {
        let value: Value
        if (rest.startsWith('&')) {
          assert.match(rest, /^&\w+$/)
          assert.ok(index < lines.length && indent(lines[index]!) > level)
          value = block(indent(lines[index]!))
          assert.ok(!Array.isArray(value) && typeof value === 'object')
          anchors[rest.slice(1)] = value
        } else if (rest) {
          value = scalar(rest)
        } else if (index < lines.length && indent(lines[index]!) > level) {
          const nested = lines[index]!.trim()
          if (nested.startsWith('[')) {
            index++
            value = scalar(nested)
          } else {
            value = block(indent(lines[index]!))
          }
        } else {
          value = ''
        }
        ;(result as Mapping)[key] = value
      }
    }
    return result
  }
  const parsed = block(0)
  assert.equal(index, lines.length, `unsupported YAML near line ${index + 1}`)
  assert.ok(!Array.isArray(parsed) && typeof parsed === 'object')
  return parsed
}

function mapping(value: Value | undefined): Mapping {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

function volumeList(service: Mapping): string[] {
  const mounts = service.volumes ?? []
  assert.ok(Array.isArray(mounts), 'unsupported volumes')
  return mounts.map((mount) => {
    assert.ok(typeof mount === 'string', 'unsupported mount')
    return mount
  })
}

function isSandboxStateRootMount(mount: string): boolean {
  return /\$\{SANDBOX_STATE[^}]*\}:\/sandbox(?::|$)/.test(mount)
}

function sandboxFileMount(file: string, mode: 'ro' | 'rw' = 'ro'): string {
  const suffix = mode === 'ro' ? ':ro' : ''
  return `\${SANDBOX_STATE:?}/${file}:/sandbox/${file}${suffix}`
}

const dockerignore = readFileSync(
  new URL('../../.dockerignore', import.meta.url),
  'utf8',
)
const composeSource = readFileSync(
  new URL('../../infra/sandbox/compose.yml', import.meta.url),
  'utf8',
)

test('.dockerignore keeps local deployment credentials out of the check image context', () => {
  const patterns = ignorePatterns(dockerignore)
  assert.ok(
    excludesPath(patterns, 'infra/app/app.env'),
    'infra/app/app.env must be ignored',
  )
  assert.ok(
    excludesPath(patterns, 'infra/app/state'),
    'infra/app/state must be ignored',
  )
  assert.ok(
    patterns.includes('!.env.example'),
    '.env.example must remain available to the check image',
  )
})

test('sandbox bambu has no state mount; app and connector get only needed files', () => {
  const compose = parseCompose(composeSource)
  const services = mapping(compose.services)

  const bambu = mapping(services.bambu)
  for (const mount of volumeList(bambu)) {
    assert.equal(
      isSandboxStateRootMount(mount),
      false,
      `bambu must not mount sandbox state: ${mount}`,
    )
    assert.doesNotMatch(mount, /\$\{SANDBOX_STATE/)
  }
  assert.ok(
    volumeList(bambu).includes('../..:/workspace:ro'),
    'bambu still needs the workspace',
  )

  assert.deepEqual(mapping(bambu.environment), {
    SANDBOX_BAMBU_ACCESS_CODE: '${SANDBOX_BAMBU_ACCESS_CODE:-}',
  })

  const app = mapping(services.app)
  assert.deepEqual(
    volumeList(app).toSorted(),
    [
      '../..:/workspace:ro',
      sandboxFileMount('app.env'),
      sandboxFileMount('keys.json'),
      sandboxFileMount('tls.crt'),
      sandboxFileMount('tls.key'),
    ].toSorted(),
  )

  const connector = mapping(services.connector)
  assert.deepEqual(
    volumeList(connector).toSorted(),
    [
      '../..:/workspace:ro',
      sandboxFileMount('bambu-credential.json'),
      sandboxFileMount('connector-data', 'rw'),
      sandboxFileMount('credential.json'),
      sandboxFileMount('runtime.json'),
      sandboxFileMount('tls.crt'),
    ].toSorted(),
  )
})

test('sandbox postgres data is a bind volume under the private state dir', () => {
  const compose = parseCompose(composeSource)
  const database = mapping(mapping(compose.volumes).database)
  assert.deepEqual(mapping(database.driver_opts), {
    type: 'none',
    o: 'bind',
    device: '${SANDBOX_STATE:?}/database',
  })
  const script = readFileSync(
    new URL('../../scripts/sandbox.ts', import.meta.url),
    'utf8',
  )
  assert.match(script, /join\(state, 'database'\)/)
  assert.match(script, /rmSync\(databaseDir/)
})
