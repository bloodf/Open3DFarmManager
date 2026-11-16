import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The harness runs against a live database and cannot be imported here, so
// these checks pin the diagnostic code paths in its source text.
const source = readFileSync(
  new URL('../../scripts/test-signalling-https.ts', import.meta.url),
  'utf8',
)

test('a failed cleanup step records its name and error code in the manifest', () => {
  const catchStart = source.indexOf('const cleanup = async (name: string')
  assert.notEqual(catchStart, -1, 'cleanup helper must exist')
  const block = source.slice(catchStart, catchStart + 1200)
  assert.match(block, /catch \(error\)/)
  assert.match(block, /failures\.push\(name\)/)
  assert.match(block, /'code' in error && typeof error\.code === 'string'/)
  assert.match(block, /await note\(`Cleanup step \$\{name\} failed: /)
})

test('a dirty source checkout error names what is dirty, bounded', () => {
  assert.match(
    source,
    /throw new Error\('Source checkout must be clean: ' \+ dirty\.slice\(0, 600\)\)/,
  )
})
