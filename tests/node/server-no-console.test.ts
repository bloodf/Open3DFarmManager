import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const serverDir = join(root, 'apps/farm/server')
// Files allowed to call console.* directly; none today. Add with a reason.
const ALLOWED = new Set<string>([])

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.(ts|js|mjs|vue)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  )
}

export function consoleCalls(source: string): string[] {
  return source.match(/\bconsole\s*\.\s*\w+/g) ?? []
}

test('server runtime code logs through createLogger, not console', () => {
  const offenders = files(serverDir)
    .map((f) => relative(root, f))
    .filter((f) => !ALLOWED.has(f))
    .filter((f) => consoleCalls(readFileSync(join(root, f), 'utf8')).length)
  assert.deepEqual(offenders, [])
})

test('guard detects a console.log added to a server file', () => {
  assert.deepEqual(consoleCalls('console.log("x")'), ['console.log'])
  assert.deepEqual(consoleCalls('console . error(e)'), ['console . error'])
  assert.deepEqual(consoleCalls('log.error("x")'), [])
})

test('database startup failure is one JSON line with a fixed code and no secrets', async () => {
  const { beginDatabaseStartup } =
    await import('../../apps/farm/server/utils/database/lifecycle.ts')
  const { setDatabasePhase } =
    await import('../../apps/farm/server/utils/database/phase.ts')
  const lines: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  const exits: number[] = []
  try {
    const secret = 'postgres://user:hunter2@db.example:5432/app'
    beginDatabaseStartup(
      { database: { enabled: true, databaseUrl: secret, extra: 1 } },
      {
        exit: (code) => void exits.push(code),
      },
    )
  } finally {
    process.stderr.write = write
    setDatabasePhase('disabled')
  }
  assert.deepEqual(exits, [1])
  assert.equal(lines.length, 1)
  assert.ok(
    lines[0]!.endsWith('\n') && lines[0]!.trim().split('\n').length === 1,
  )
  const entry = JSON.parse(lines[0]!)
  assert.equal(entry.level, 'error')
  assert.equal(entry.code, 'invalid-config')
  assert.ok(!lines[0]!.includes('hunter2'))
})
