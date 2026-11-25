import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const renovate = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
  packageRules: Array<Record<string, unknown>>
}

test('Renovate keeps Node 22 compatibility jobs on Node 22', () => {
  const rule = renovate.packageRules.find(
    (candidate) =>
      Array.isArray(candidate.matchManagers) &&
      candidate.matchManagers.includes('github-actions') &&
      Array.isArray(candidate.matchDepNames) &&
      candidate.matchDepNames.includes('node') &&
      candidate.allowedVersions === '<23',
  )

  assert.ok(rule, 'expected a GitHub Actions Node rule capped below Node 23')
  assert.deepEqual(rule.matchFileNames, [
    '.github/workflows/ci.yml',
    '.github/workflows/sim.yml',
  ])
  assert.equal(rule.matchCurrentVersion, '/^22\\./')
})
