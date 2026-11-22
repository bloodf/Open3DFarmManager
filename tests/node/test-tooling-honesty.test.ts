import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('farm mock acceptance rows reflect individual requirement results', async () => {
  const script = await source('scripts/test-farm-mock-acceptance.ts')
  assert.match(script, /--test-reporter=tap/)
  assert.match(script, /requirementResults/)
  assert.doesNotMatch(script, /const status = passed \? 'pass' : 'fail'/)
})

test('disposable PostgreSQL cleanup failures are reported', async () => {
  const helper = await source('tests/helpers/disposable-postgres.ts')
  assert.doesNotMatch(helper, /catch \{\}/)
  assert.doesNotMatch(helper, /\.catch\(\(\) => \{\}\)/)
})

test('website screenshot attribution tolerates missing commit provenance', async () => {
  const checker = await source('apps/website/verify.mjs')
  assert.match(
    checker,
    /provenance\.commit\s*\?\s*\[\[provenance\.commit\.slice/,
  )
})
