// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('desktop documentation points to the offline installation and its limits', () => {
  const readme = read('README.md')
  const desktop = read('docs/DESKTOP.md')
  assert.match(readme, /docs\/DESKTOP\.md/)
  for (const text of ['npm ci --offline', 'desktop:check', 'OPENFARM_SIM=docker', 'OPENFARM_PG=docker', 'RTSP', 'Bambu', 'PostgreSQL', 'Chrome']) assert.ok(desktop.includes(text), text)
  assert.match(desktop, /não comprova que os cartões de impressoras aparecem/)
})

test('desktop check exposes the documented mock farm smoke step', () => {
  const result = spawnSync(process.execPath, ['scripts/desktop-check.ts', '--list'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /app-smoke.*mocks.*Chrome/)
})
