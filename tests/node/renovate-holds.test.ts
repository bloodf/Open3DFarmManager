import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const renovate = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
  packageRules: Array<Record<string, unknown>>
}

test('Renovate keeps PostgreSQL below major 18 in the persistent database stacks', () => {
  const rule = renovate.packageRules.find(
    (candidate) =>
      Array.isArray(candidate.matchManagers) &&
      candidate.matchManagers.includes('docker-compose') &&
      Array.isArray(candidate.matchDepNames) &&
      candidate.matchDepNames.includes('postgres') &&
      candidate.allowedVersions === '<18',
  )

  assert.ok(rule, 'expected PostgreSQL capped below major 18')
  assert.deepEqual(rule.matchFileNames, [
    'infra/app/docker-compose.yml',
    'infra/sandbox/compose.yml',
  ])
  assert.match(String(rule.description), /#919/)
})

test('Renovate keeps Ubuntu runner pins on 24.04 in CI and simulator workflows', () => {
  const rule = renovate.packageRules.find(
    (candidate) =>
      Array.isArray(candidate.matchManagers) &&
      candidate.matchManagers.includes('github-actions') &&
      Array.isArray(candidate.matchDepNames) &&
      candidate.matchDepNames.includes('ubuntu') &&
      candidate.allowedVersions === '<25',
  )

  assert.ok(rule, 'expected Ubuntu runners held on 24.04')
  assert.deepEqual(rule.matchDepNames, ['ubuntu'])
  assert.equal(rule.matchCurrentVersion, '/^24\\.04/')
  assert.deepEqual(rule.matchFileNames, [
    '.github/workflows/ci.yml',
    '.github/workflows/sim.yml',
  ])
  assert.match(String(rule.description), /#918/)
})
