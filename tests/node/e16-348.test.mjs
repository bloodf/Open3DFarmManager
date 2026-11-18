// SPDX-License-Identifier: MIT
// #348: npm workspaces are the only package manager. Static checks run by
// default; the install check needs the registry and is opt-in.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const json = (path) => JSON.parse(read(path))
const manifests = [
  'package.json',
  'apps/farm/package.json',
  'packages/connector/package.json',
  'packages/farm-protocol/package.json',
  'packages/shared/package.json',
  'packages/sim-cams/package.json',
  'packages/sim-tools/package.json',
  'packages/webrtc-experiment/package.json',
]
const tracked = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
assert.equal(tracked.status, 0, tracked.stderr)
const files = tracked.stdout
  .split('\0')
  .filter(Boolean)
  .filter((path) => existsSync(join(root, path)))
const isDocument = (path) => path.endsWith('.md') || path.startsWith('docs/')
const thisTest = 'tests/node/e16-348.test.mjs'
// Spelled in pieces so this file never matches its own scan.
const legacy = `pn${'pm'}`
const scan = (pattern, skip = () => false) =>
  files
    .filter((path) => !isDocument(path) && path !== thisTest && !skip(path))
    .flatMap((path) => {
      let text
      try {
        text = read(path)
      } catch {
        return []
      }
      if (text.includes('\0')) return []
      return text
        .split('\n')
        .map((line, index) => ({ path, line: index + 1, text: line }))
        .filter((hit) => pattern.test(hit.text))
        .map((hit) => `${hit.path}:${hit.line}`)
    })

test('legacy manager files and pin are gone; package-lock.json is committed', () => {
  assert.equal(existsSync(join(root, `${legacy}-lock.yaml`)), false)
  assert.equal(existsSync(join(root, `${legacy}-workspace.yaml`)), false)
  assert.ok(files.includes('package-lock.json'))
  const rootManifest = json('package.json')
  assert.equal(rootManifest.packageManager, undefined)
  assert.deepEqual(rootManifest.workspaces, ['apps/*', 'packages/*'])
  const lock = json('package-lock.json')
  assert.equal(lock.lockfileVersion, 3)
})

test('workspace dependencies use the npm range * and resolve to local packages', () => {
  const lock = json('package-lock.json')
  for (const path of manifests) {
    const manifest = json(path)
    for (const group of ['dependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(manifest[group] ?? {})) {
        assert.notEqual(
          String(range).startsWith('workspace:'),
          true,
          `${path} ${name}`,
        )
        if (name.startsWith('@open3dfarmmanager/')) {
          assert.equal(range, '*', `${path} ${name}`)
          assert.equal(lock.packages[`node_modules/${name}`]?.link, true, name)
        }
      }
    }
  }
})

test('typescript stays hoisted with its JavaScript API so vue-tsc resolves it, and no package-local node_modules are locked', () => {
  const lock = json('package-lock.json')
  const rootManifest = json('package.json')
  assert.match(rootManifest.devDependencies.typescript, /^6\./)
  assert.equal(rootManifest.devDependencies.typescript7, 'npm:typescript@7.0.2')
  assert.match(rootManifest.scripts.typecheck, /typescript7\/bin\/tsc/)
  for (const key of Object.keys(lock.packages)) {
    assert.doesNotMatch(key, /^(?:apps|packages)\/[^/]+\/node_modules\//, key)
  }
})

test('install is script-free and CI installs from the lockfile with npm', () => {
  assert.equal(read('.npmrc').trim(), 'ignore-scripts=true')
  const config = spawnSync('npm', ['config', 'get', 'ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(config.stdout.trim(), 'true')
  for (const workflow of ['ci.yml', 'sim.yml']) {
    const text = read(`.github/workflows/${workflow}`)
    assert.equal(text.includes(legacy), false)
    assert.match(text, /npm ci --ignore-scripts/)
    assert.doesNotMatch(text, /npm install\b/)
  }
  const dockerfile = read('apps/farm/Dockerfile')
  assert.match(dockerfile, /COPY package\.json package-lock\.json \.npmrc/)
  assert.match(dockerfile, /RUN npm ci --ignore-scripts/)
  assert.match(read('scripts/local-ci.sh'), /npm ci --ignore-scripts/)
})

test('no tracked non-document file mentions the legacy manager', () => {
  assert.deepEqual(scan(new RegExp(`\\b${legacy}\\b`)), [])
})

test('no tracked file reaches into package-local node_modules', () => {
  assert.deepEqual(
    scan(/packages\/[a-z-]+\/node_modules|apps\/farm\/node_modules/),
    [],
  )
  // package-lock.json is tracked, scanned above, and must be clean too.
  assert.ok(files.includes('package-lock.json'))
})

test('package imports used by helpers resolve through the workspace', () => {
  const require = createRequire(join(root, 'tests/helpers/probe.ts'))
  for (const specifier of [
    'zod',
    'ws',
    '@types/ws/package.json',
    'node-datachannel',
    'nuxt/server',
    'nuxt/package.json',
    'openid-client',
    'vue',
    'vue-router',
  ]) {
    assert.doesNotThrow(() => require.resolve(specifier), specifier)
  }
})

test('browser scenario servers start the farm through the npm workspace', () => {
  assert.match(
    read('playwright.kobralink.config.ts'),
    /npm run dev -w @open3dfarmmanager\/farm -- --port 3197/,
  )
  assert.match(read('scripts/test-kobralink-ui.mjs'), /'npx'/)
  assert.match(read('scripts/test-auth-session-e2e.ts'), /'npx'/)
})

test('local CI self-test passes against npm', () => {
  const result = spawnSync('bash', ['scripts/test-local-ci.sh'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test(
  'npm ci runs no install script',
  { skip: process.env.OPENFARM_E16_348_INSTALL !== '1' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'e16-348-install-'))
    try {
      for (const path of [
        '.npmrc',
        'package.json',
        'package-lock.json',
        ...manifests.slice(1),
      ]) {
        cpSync(join(root, path), join(directory, path), { recursive: true })
      }
      const result = spawnSync('npm', ['ci', '--foreground-scripts'], {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      assert.equal(result.status, 0, result.stderr)
      const output = result.stdout + result.stderr
      assert.doesNotMatch(output, /^> .+@.+ (?:pre|post)?install$/m)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
