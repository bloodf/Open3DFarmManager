import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  MIN_SUPPORTED_NODE_VERSION,
  assertSupportedNodeRuntime,
  isSupportedNodeVersion,
} from '../helpers/node-version.ts'

const repoRoot = join(import.meta.dirname, '..', '..')

test('.nvmrc pins a supported Node 22.18+ runtime', () => {
  const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim()
  assert.match(nvmrc, /^22\.\d+\.\d+$/)
  assert.equal(isSupportedNodeVersion(nvmrc), true)
})

test('shared minimum version helper validates >=22.18.0 <25 and rejects unsupported runtimes', () => {
  assert.equal(MIN_SUPPORTED_NODE_VERSION, '22.18.0')
  assert.equal(isSupportedNodeVersion('22.18.0'), true)
  assert.equal(isSupportedNodeVersion('v22.23.5'), true)
  assert.equal(isSupportedNodeVersion('23.9.0'), true)
  assert.equal(isSupportedNodeVersion('24.22.3'), true)

  assert.equal(isSupportedNodeVersion('22.17.9'), false)
  assert.equal(isSupportedNodeVersion('21.7.3'), false)
  assert.equal(isSupportedNodeVersion('20.18.0'), false)
  assert.equal(isSupportedNodeVersion('25.0.0'), false)
  assert.equal(isSupportedNodeVersion('invalid'), false)

  assert.doesNotThrow(() => assertSupportedNodeRuntime({ node: '22.23.5' }))
  assert.doesNotThrow(() => assertSupportedNodeRuntime({ node: '24.22.3' }))
  assert.throws(
    () =>
      assertSupportedNodeRuntime({
        node: '22.23.5',
        bun: '1.2.0',
      }),
    /Node >=22\.18\.0 <25 is required/,
  )
  assert.throws(
    () => assertSupportedNodeRuntime({ node: '22.17.0' }),
    /Node >=22\.18\.0 <25 is required/,
  )
})

test('no exact Node 24.22 or startsWith("24.") policy checks remain in scripts or packages', () => {
  const result = spawnSync(
    'rg',
    ['-n', "v24\\.22|startsWith\\('24\\.'\\)", 'scripts', 'packages'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )

  assert.equal(
    result.status,
    1,
    `Expected no matches from rg, got status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
  )
  assert.equal(result.stdout.trim(), '')
})

test('CI workflow includes manual-trigger Node 22 job next to Node 24 job', () => {
  const workflow = readFileSync(
    join(repoRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  )

  assert.match(workflow, /^on:\s*\[workflow_dispatch\]$/m)
  assert.match(workflow, /^\s{2}code:\s*$/m)
  assert.match(workflow, /^\s{2}code-node22:\s*$/m)
  assert.match(
    workflow,
    /code-node22:[\s\S]*?node-version:\s*'22\.23\.5'[\s\S]*?run:\s*pnpm run check:all/,
  )
})

test('connector build targets node22 and built CLI runs cleanly without ExperimentalWarning', () => {
  const buildMjs = readFileSync(
    join(repoRoot, 'packages', 'connector', 'build.mjs'),
    'utf8',
  )
  assert.match(buildMjs, /target:\s*'node22'/)

  execFileSync(process.execPath, ['packages/connector/build.mjs'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })

  const cliResult = spawnSync(
    process.execPath,
    ['packages/connector/dist/cli.js', '--version'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )

  assert.equal(cliResult.status, 0, cliResult.stderr)
  assert.equal(cliResult.stdout.trim(), '0.0.1')
  assert.equal(cliResult.stderr, '')
})

test('connector SQLite modules suppress only the node:sqlite ExperimentalWarning on stderr', () => {
  const probeScript = `
    import './packages/connector/src/auth/replay.ts';
    import './packages/connector/src/control/command-journal.ts';
    process.emitWarning('custom non-sqlite warning', 'CustomWarning');
  `
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', probeScript],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )

  assert.equal(probe.status, 0, probe.stderr)
  assert.doesNotMatch(probe.stderr, /SQLite is an experimental feature/)
  assert.match(probe.stderr, /CustomWarning: custom non-sqlite warning/)
})
