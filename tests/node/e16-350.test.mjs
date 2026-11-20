// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LOCKFILE_PATH,
  parseLockfilePackages,
} from '../../scripts/desktop-deps-report.mjs'
import { buildDesktopBundle } from '../../scripts/desktop-bundle.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createTarballBuffer(tmpRoot, pkgJson, files = {}) {
  const safeName = pkgJson.name.replaceAll('/', '_')
  const srcRoot = join(tmpRoot, `pkg-${safeName}-${pkgJson.version}`)
  const pkgRoot = join(srcRoot, 'package')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(
    join(pkgRoot, 'package.json'),
    `${JSON.stringify(pkgJson, null, 2)}\n`,
  )
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(pkgRoot, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const tgzPath = join(tmpRoot, `${safeName}-${pkgJson.version}.tgz`)
  const tar = spawnSync('tar', ['-czf', tgzPath, '-C', srcRoot, 'package'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  assert.equal(tar.status, 0, tar.stderr)
  const buf = readFileSync(tgzPath)
  const integrity = `sha512-${createHash('sha512').update(buf).digest('base64')}`
  return { buf, integrity }
}

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(full))
    } else {
      out.push(full)
    }
  }
  return out
}

function runNodeScriptOrNpm(scriptName, scriptPath, args = [], extraEnv = {}) {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const hasNpmScript = Boolean(pkg?.scripts?.[scriptName])
  const cmd = hasNpmScript ? 'npm' : process.execPath
  const cmdArgs = hasNpmScript
    ? ['run', '--silent', scriptName, ...(args.length ? ['--', ...args] : [])]
    : [scriptPath, ...args]

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', rejectPromise)
    child.on('close', (status) => {
      resolvePromise({ status, stdout, stderr })
    })
  })
}

test('desktop:deps-report prints full lockfile package list and marks platform packages', async () => {
  const packages = parseLockfilePackages(DEFAULT_LOCKFILE_PATH)
  assert.ok(
    packages.length > 600,
    `expected >600 packages, got ${packages.length}`,
  )

  const res = await runNodeScriptOrNpm(
    'desktop:deps-report',
    'scripts/desktop-deps-report.mjs',
  )
  assert.equal(res.status, 0, res.stderr)

  const expectedPinned = [
    'nuxt@4.6.4',
    'vitest@5.1.0',
    'typescript@7.0.2',
    'typescript@6.0.3',
    'vue-tsc@3.3.14',
    '@playwright/test@1.65.0',
  ]
  for (const spec of expectedPinned) {
    assert.match(
      res.stdout,
      new RegExp(
        `^${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`,
        'm',
      ),
    )
  }

  const linuxX64Packages = packages.filter((p) => p.isLinuxX64)
  assert.ok(linuxX64Packages.length >= 6)
  for (const pkg of linuxX64Packages) {
    assert.match(
      res.stdout,
      new RegExp(
        `${pkg.spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\[platform\\b[^\\]]*target=linux-x64\\]`,
      ),
    )
  }
})

test('desktop:deps-report --registry reports missing packages including platform packages via loopback mirror', async (t) => {
  const packages = parseLockfilePackages(DEFAULT_LOCKFILE_PATH)
  const missingSpecs = new Set([
    'nuxt@4.6.4',
    '@typescript/typescript-linux-x64@7.0.2',
    '@node-datachannel/linux-x64-gnu@0.33.6',
  ])

  const missingPathnames = new Set()
  const missingNamesToVersions = new Map()
  for (const pkg of packages) {
    if (!missingSpecs.has(pkg.spec)) continue
    if (pkg.resolved) {
      missingPathnames.add(new URL(pkg.resolved).pathname)
    }
    if (!missingNamesToVersions.has(pkg.name)) {
      missingNamesToVersions.set(pkg.name, new Set())
    }
    missingNamesToVersions.get(pkg.name).add(pkg.version)
  }

  const server = createServer((req, res) => {
    const reqPath = (req.url ?? '/').split('?')[0]
    if (reqPath.endsWith('.tgz')) {
      // Exercise 405 HEAD -> GET fallback for vitest tarball.
      if (req.method === 'HEAD' && reqPath.includes('/vitest/-/vitest-')) {
        res.writeHead(405)
        res.end()
        return
      }
      if (missingPathnames.has(reqPath)) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end()
      return
    }

    const pkgName = decodeURIComponent(reqPath.slice(1))
    if (pkgName !== 'nuxt' && missingNamesToVersions.has(pkgName)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: pkgName, versions: {} }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  )
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  const { port } = server.address()
  const registryUrl = `http://127.0.0.1:${port}`

  const res = await runNodeScriptOrNpm(
    'desktop:deps-report',
    'scripts/desktop-deps-report.mjs',
    ['--registry', registryUrl],
  )
  assert.equal(res.status, 0, res.stderr)
  assert.match(
    res.stdout,
    /Missing from registry http:\/\/127\.0\.0\.1:\d+ \(3\):/,
  )
  assert.match(res.stdout, /^nuxt@4\.6\.4 \(HTTP 404\)$/m)
  assert.match(
    res.stdout,
    /^@typescript\/typescript-linux-x64@7\.0\.2 \[platform .*target=linux-x64\] \(version 7\.0\.2 absent in packument\)$/m,
  )
  assert.match(
    res.stdout,
    /^@node-datachannel\/linux-x64-gnu@0\.33\.6 \[platform .*target=linux-x64\] \(version 0\.33\.6 absent in packument\)$/m,
  )
  assert.doesNotMatch(res.stdout, /^vitest@5\.1\.0 .*\[MISSING/m)
})

test('desktop:bundle produces a clean secret-free cache archive that installs offline and passes build', async (t) => {
  const tempRoot = makeTempDir('e16-350-bundle-')
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const secretAuthToken = 'SECRET_AUTH_TOKEN_E16_350'
  const secretCookie = 'SECRET_COOKIE_E16_350'
  const secretHeader = 'SECRET_HEADER_E16_350'

  const tgzDir = join(tempRoot, 'tarballs')
  mkdirSync(tgzDir, { recursive: true })

  const universalPkg = createTarballBuffer(
    tgzDir,
    { name: 'offline-helper', version: '1.2.3', main: 'index.js' },
    { 'index.js': 'export const helperValue = "offline-ok"\n' },
  )
  const linuxGnuPkg = createTarballBuffer(
    tgzDir,
    {
      name: '@fake-native/linux-x64-gnu',
      version: '1.0.0',
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
      main: 'index.js',
    },
    { 'index.js': 'export const target = "linux-x64-gnu"\n' },
  )
  const linuxMuslPkg = createTarballBuffer(
    tgzDir,
    {
      name: '@fake-native/linux-x64-musl',
      version: '1.0.0',
      os: ['linux'],
      cpu: ['x64'],
      libc: ['musl'],
      main: 'index.js',
    },
    { 'index.js': 'export const target = "linux-x64-musl"\n' },
  )
  const darwinArmPkg = createTarballBuffer(
    tgzDir,
    {
      name: '@fake-native/darwin-arm64',
      version: '1.0.0',
      os: ['darwin'],
      cpu: ['arm64'],
      main: 'index.js',
    },
    { 'index.js': 'export const target = "darwin-arm64"\n' },
  )

  const tarballs = new Map([
    ['/offline-helper/-/offline-helper-1.2.3.tgz', universalPkg.buf],
    ['/@fake-native/linux-x64-gnu/-/linux-x64-gnu-1.0.0.tgz', linuxGnuPkg.buf],
    [
      '/@fake-native/linux-x64-musl/-/linux-x64-musl-1.0.0.tgz',
      linuxMuslPkg.buf,
    ],
    ['/@fake-native/darwin-arm64/-/darwin-arm64-1.0.0.tgz', darwinArmPkg.buf],
  ])

  const server = createServer((req, res) => {
    const reqPath = (req.url ?? '/').split('?')[0]
    const body = tarballs.get(reqPath)
    if (!body) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'set-cookie': `session=${secretCookie}; HttpOnly`,
      'x-auth-token': secretHeader,
    })
    res.end(body)
  })

  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  )
  const { port } = server.address()
  const registryUrl = `http://127.0.0.1:${port}`

  const repoDir = join(tempRoot, 'repo')
  const appDir = join(repoDir, 'apps/farm')
  const libDir = join(repoDir, 'packages/shared')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(libDir, { recursive: true })

  writeFileSync(join(repoDir, '.npmrc'), 'ignore-scripts=true\n')
  writeFileSync(
    join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: 'synthetic-desktop-repo',
        private: true,
        type: 'module',
        workspaces: ['apps/*', 'packages/*'],
        scripts: {
          build: 'npm run build -w @synthetic/app',
        },
        dependencies: {
          '@synthetic/shared': '*',
          'offline-helper': '1.2.3',
        },
        optionalDependencies: {
          '@fake-native/linux-x64-gnu': '1.0.0',
          '@fake-native/linux-x64-musl': '1.0.0',
          '@fake-native/darwin-arm64': '1.0.0',
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(libDir, 'package.json'),
    JSON.stringify(
      {
        name: '@synthetic/shared',
        version: '0.0.1',
        type: 'module',
        main: 'index.mjs',
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(libDir, 'index.mjs'),
    `import { helperValue } from 'offline-helper'\nexport const sharedMsg = helperValue\n`,
  )
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: '@synthetic/app',
        version: '0.0.1',
        type: 'module',
        scripts: {
          prepare: 'node --check build.mjs',
          build: 'node build.mjs',
        },
        dependencies: {
          '@synthetic/shared': '*',
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(appDir, 'build.mjs'),
    `import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { sharedMsg } from '@synthetic/shared'
import { target } from '@fake-native/linux-x64-gnu'
assert.equal(sharedMsg, 'offline-ok')
assert.equal(target, 'linux-x64-gnu')
writeFileSync('built-marker.txt', sharedMsg + ':' + target)
`,
  )

  writeFileSync(
    join(repoDir, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'synthetic-desktop-repo',
        version: '0.0.1',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'synthetic-desktop-repo',
            version: '0.0.1',
            workspaces: ['apps/*', 'packages/*'],
            dependencies: {
              '@synthetic/shared': '*',
              'offline-helper': '1.2.3',
            },
            optionalDependencies: {
              '@fake-native/linux-x64-gnu': '1.0.0',
              '@fake-native/linux-x64-musl': '1.0.0',
              '@fake-native/darwin-arm64': '1.0.0',
            },
          },
          'apps/farm': {
            name: '@synthetic/app',
            version: '0.0.1',
            dependencies: {
              '@synthetic/shared': '*',
            },
          },
          'packages/shared': {
            name: '@synthetic/shared',
            version: '0.0.1',
          },
          'node_modules/@synthetic/app': {
            resolved: 'apps/farm',
            link: true,
          },
          'node_modules/@synthetic/shared': {
            resolved: 'packages/shared',
            link: true,
          },
          'node_modules/offline-helper': {
            version: '1.2.3',
            resolved:
              'https://registry.npmjs.org/offline-helper/-/offline-helper-1.2.3.tgz',
            integrity: universalPkg.integrity,
          },
          'node_modules/@fake-native/linux-x64-gnu': {
            version: '1.0.0',
            os: ['linux'],
            cpu: ['x64'],
            libc: ['glibc'],
            optional: true,
            resolved:
              'https://registry.npmjs.org/@fake-native/linux-x64-gnu/-/linux-x64-gnu-1.0.0.tgz',
            integrity: linuxGnuPkg.integrity,
          },
          'node_modules/@fake-native/linux-x64-musl': {
            version: '1.0.0',
            os: ['linux'],
            cpu: ['x64'],
            libc: ['musl'],
            optional: true,
            resolved:
              'https://registry.npmjs.org/@fake-native/linux-x64-musl/-/linux-x64-musl-1.0.0.tgz',
            integrity: linuxMuslPkg.integrity,
          },
          'node_modules/@fake-native/darwin-arm64': {
            version: '1.0.0',
            os: ['darwin'],
            cpu: ['arm64'],
            optional: true,
            resolved:
              'https://registry.npmjs.org/@fake-native/darwin-arm64/-/darwin-arm64-1.0.0.tgz',
            integrity: darwinArmPkg.integrity,
          },
        },
      },
      null,
      2,
    ),
  )

  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  const archivePath = join(tempRoot, 'desktop-bundle.tar.gz')
  const bundleResult = await buildDesktopBundle({
    repoRoot: repoDir,
    outPath: archivePath,
    registryUrl,
    env: {
      ...process.env,
      [`npm_config_//127.0.0.1:${port}/:_authToken`]: secretAuthToken,
    },
    log: () => {},
  })
  assert.deepEqual(bundleResult.targets, ['glibc', 'musl'])
  assert.ok(existsSync(archivePath))

  // Close the fake registry completely to enforce network-blocked offline install.
  server.closeAllConnections?.()
  await new Promise((resolveClose) => server.close(resolveClose))

  const tarList = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
  assert.equal(tarList.status, 0, tarList.stderr)
  const archiveEntries = tarList.stdout.split('\n').filter(Boolean)
  assert.ok(archiveEntries.length > 0)
  for (const entry of archiveEntries) {
    assert.ok(
      entry === '_cacache' ||
        entry === '_cacache/' ||
        entry.startsWith('_cacache/content-v2') ||
        entry.startsWith('_cacache/index-v5'),
      `Unexpected entry outside npm cache: ${entry}`,
    )
    assert.doesNotMatch(entry, /(^|\/)\._/)
  }

  const unpackedCache = join(tempRoot, 'unpacked-cache')
  mkdirSync(unpackedCache, { recursive: true })
  const untar = spawnSync('tar', ['-xzf', archivePath, '-C', unpackedCache], {
    encoding: 'utf8',
  })
  assert.equal(untar.status, 0, untar.stderr)

  for (const filePath of walkFiles(unpackedCache)) {
    const content = readFileSync(filePath)
    assert.equal(
      content.includes(secretAuthToken),
      false,
      `Found auth token in ${filePath}`,
    )
    assert.equal(
      content.includes(secretCookie),
      false,
      `Found cookie secret in ${filePath}`,
    )
    assert.equal(
      content.includes(secretHeader),
      false,
      `Found auth header secret in ${filePath}`,
    )
  }

  const offlineCheckout = join(tempRoot, 'offline-desktop')
  cpSync(repoDir, offlineCheckout, { recursive: true })

  const offlineInstall = spawnSync(
    'npm',
    [
      'ci',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--os=linux',
      '--cpu=x64',
      '--libc=glibc',
      '--cache',
      unpackedCache,
      '--registry',
      'http://127.0.0.1:1',
    ],
    { cwd: offlineCheckout, encoding: 'utf8' },
  )
  assert.equal(
    offlineInstall.status,
    0,
    offlineInstall.stdout + offlineInstall.stderr,
  )
  assert.equal(
    existsSync(
      join(offlineCheckout, 'node_modules/@fake-native/linux-x64-gnu'),
    ),
    true,
  )
  assert.equal(
    existsSync(join(offlineCheckout, 'node_modules/@fake-native/darwin-arm64')),
    false,
  )

  const offlineBuild = spawnSync('npm', ['run', 'build'], {
    cwd: offlineCheckout,
    encoding: 'utf8',
  })
  assert.equal(
    offlineBuild.status,
    0,
    offlineBuild.stdout + offlineBuild.stderr,
  )
  assert.equal(
    readFileSync(join(offlineCheckout, 'apps/farm/built-marker.txt'), 'utf8'),
    'offline-ok:linux-x64-gnu',
  )

  // Also verify musl target installs cleanly offline from the same bundle.
  const offlineMuslCheckout = join(tempRoot, 'offline-desktop-musl')
  cpSync(repoDir, offlineMuslCheckout, { recursive: true })
  const offlineMuslInstall = spawnSync(
    'npm',
    [
      'ci',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--os=linux',
      '--cpu=x64',
      '--libc=musl',
      '--cache',
      unpackedCache,
      '--registry',
      'http://127.0.0.1:1',
    ],
    { cwd: offlineMuslCheckout, encoding: 'utf8' },
  )
  assert.equal(
    offlineMuslInstall.status,
    0,
    offlineMuslInstall.stdout + offlineMuslInstall.stderr,
  )
  assert.equal(
    existsSync(
      join(offlineMuslCheckout, 'node_modules/@fake-native/linux-x64-musl'),
    ),
    true,
  )
})

test('desktop-offline-install doc documents fallbacks for every Linux x64 platform package and TS 6 fallback works', () => {
  const doc = readFileSync(
    join(REPO_ROOT, 'docs/desktop-offline-install.md'),
    'utf8',
  )
  assert.match(doc, /desktop:deps-report/)
  assert.match(doc, /desktop:bundle/)
  assert.match(doc, /npm ci --offline/)
  assert.match(doc, /npm run build/)

  const requiredPackages = [
    '@node-datachannel/linux-x64-gnu',
    '@esbuild/linux-x64',
    '@rollup/rollup-linux-x64-gnu',
    '@rolldown/binding-linux-x64-gnu',
    'lightningcss-linux-x64-gnu',
    '@typescript/typescript-linux-x64',
  ]
  for (const pkgName of requiredPackages) {
    assert.ok(
      doc.includes(pkgName),
      `Expected fallback doc to cover ${pkgName}`,
    )
  }
  assert.match(doc, /typescript\/bin\/tsc --noEmit/)

  const ts6Bin = join(REPO_ROOT, 'node_modules/typescript/bin/tsc')
  if (existsSync(ts6Bin)) {
    const ts6Check = spawnSync(process.execPath, [ts6Bin, '--noEmit'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    assert.equal(ts6Check.status, 0, ts6Check.stdout + ts6Check.stderr)
  }
})
