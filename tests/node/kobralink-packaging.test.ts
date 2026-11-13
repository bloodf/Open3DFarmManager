// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface LockMetadata {
  schema: string
  upstream: {
    repository: string
    ref: string
    commit: string
    version: string
    license: string
    dockerfile: string
  }
  policy: {
    vendorUpstream: boolean
    commitArtifactsOrCertificates: boolean
    redistributeImages: boolean
    processSeparationSettlesLicensing: boolean
  }
}

interface DestinationOptions {
  expectedUid?: number
  exclusionRoots?: string[]
}

interface VerifiedCheckout {
  verified: boolean
  path: string
  commit: string
  version: string
}

interface SourceModule {
  REPOSITORY_ROOT: string
  LOCK_FILE_PATH: string
  COMPOSE_FILE_PATH: string
  SUPPORTED_UPSTREAM_ENV_KEYS: readonly string[]
  loadLockMetadata: (lockPath?: string) => LockMetadata
  assertExternalDestination: (
    destinationPath: string,
    options?: DestinationOptions,
  ) => string
  verifyCheckout: (
    targetPath: string,
    lockMetadata?: LockMetadata,
    options?: DestinationOptions,
  ) => Promise<VerifiedCheckout>
  cloneOrFetch: (
    targetPath: string,
    lockMetadata?: LockMetadata,
    options?: DestinationOptions,
  ) => Promise<VerifiedCheckout>
  parseComposeRecipe: (text: string) => Record<string, unknown>
  verifyComposeRecipe: (
    composePath?: string,
    lockMetadata?: LockMetadata,
  ) => { verified: boolean; service: string; commit: string; shortSha: string }
}

const moduleUrl = new URL('../../scripts/kobralink-source.mjs', import.meta.url)
  .href
const {
  REPOSITORY_ROOT,
  COMPOSE_FILE_PATH,
  loadLockMetadata,
  assertExternalDestination,
  verifyCheckout,
  cloneOrFetch,
  parseComposeRecipe,
  verifyComposeRecipe,
} = (await import(moduleUrl)) as SourceModule

const lockMetadata = loadLockMetadata()
const repoComposeText = readFileSync(COMPOSE_FILE_PATH, 'utf8')

function createSyntheticUpstreamRepo(
  rootDir: string,
  options: {
    version?: string
    license?: string
    remoteUrl?: string
    omitDockerfile?: boolean
  } = {},
): { repoDir: string; commit: string; lock: LockMetadata } {
  const repoDir = join(rootDir, 'synthetic-kobralink')
  mkdirSync(join(repoDir, 'apps/api'), { recursive: true })
  mkdirSync(join(repoDir, 'infra'), { recursive: true })

  writeFileSync(
    join(repoDir, 'package.json'),
    JSON.stringify({
      name: 'kobralink',
      version: options.version ?? '0.5.0',
    }),
  )
  writeFileSync(
    join(repoDir, 'apps/api/package.json'),
    JSON.stringify({
      name: '@kobralink/api',
      version: options.version ?? '0.5.0',
      license: options.license ?? 'GPL-3.0-only',
    }),
  )
  if (!options.omitDockerfile) {
    writeFileSync(
      join(repoDir, 'infra/Dockerfile'),
      'FROM oven/bun:1.4.2-slim\nWORKDIR /repo/apps/api\nCMD ["bun", "src/main.ts"]\n',
    )
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  execFileSync('git', ['init', repoDir], { env: gitEnv, stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      options.remoteUrl ?? lockMetadata.upstream.repository,
    ],
    { env: gitEnv, stdio: 'ignore' },
  )
  execFileSync('git', ['-C', repoDir, 'add', '.'], {
    env: gitEnv,
    stdio: 'ignore',
  })
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'initial'], {
    env: gitEnv,
    stdio: 'ignore',
  })
  const commit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()

  const lock: LockMetadata = {
    ...lockMetadata,
    upstream: {
      ...lockMetadata.upstream,
      commit,
    },
  }
  return { repoDir, commit, lock }
}

function checkModifiedCompose(transform: (raw: string) => string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'o3dfm-kobralink-compose-'))
  const file = join(tempDir, 'docker-compose.yml')
  try {
    writeFileSync(file, transform(repoComposeText))
    return verifyComposeRecipe(file, lockMetadata)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

test('lock metadata pins exact upstream commit, version, license and non-redistribution policy', () => {
  assert.equal(lockMetadata.schema, 'open3dfarmmanager.kobralink-pin.v1')
  assert.equal(
    lockMetadata.upstream.repository,
    'https://github.com/NatHacks/Kobralink.git',
  )
  assert.equal(lockMetadata.upstream.ref, 'v0.5.0')
  assert.equal(
    lockMetadata.upstream.commit,
    '5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1',
  )
  assert.equal(lockMetadata.upstream.version, '0.5.0')
  assert.equal(lockMetadata.upstream.license, 'GPL-3.0-only')
  assert.equal(lockMetadata.upstream.dockerfile, 'infra/Dockerfile')
  assert.equal(lockMetadata.policy.vendorUpstream, false)
  assert.equal(lockMetadata.policy.commitArtifactsOrCertificates, false)
  assert.equal(lockMetadata.policy.redistributeImages, false)
  assert.equal(lockMetadata.policy.processSeparationSettlesLicensing, false)
})

test('no certificate, private key, PEM or vendored code files exist under infra/kobralink', () => {
  const infraKobralinkDir = join(REPOSITORY_ROOT, 'infra/kobralink')
  assert.ok(existsSync(infraKobralinkDir), 'infra/kobralink must exist')

  const allowedFiles = new Set([
    'README.md',
    'docker-compose.yml',
    'upstream.lock',
  ])
  const forbiddenExtensions = [
    '.crt',
    '.key',
    '.pem',
    '.cer',
    '.der',
    '.pfx',
    '.p12',
  ]

  const scanDirectory = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      assert.ok(
        !entry.isSymbolicLink(),
        `Symlink not permitted under infra/kobralink: ${fullPath}`,
      )
      if (entry.isDirectory()) {
        scanDirectory(fullPath)
      } else {
        if (dir === infraKobralinkDir) {
          assert.ok(
            allowedFiles.has(entry.name),
            `Unexpected file under infra/kobralink: ${entry.name}`,
          )
        }
        const lower = entry.name.toLowerCase()
        for (const ext of forbiddenExtensions) {
          assert.ok(
            !lower.endsWith(ext),
            `Forbidden certificate or key file detected: ${fullPath}`,
          )
        }
        const content = readFileSync(fullPath, 'utf8')
        assert.doesNotMatch(
          content,
          /-----BEGIN (?:RSA |EC |OPENSSH )?(?:PRIVATE KEY|CERTIFICATE)-----/,
          `PEM material must not appear in ${fullPath}`,
        )
      }
    }
  }

  scanDirectory(infraKobralinkDir)
})

test('repository docker-compose recipe passes structural isolation and exposure checks', () => {
  const res = verifyComposeRecipe(COMPOSE_FILE_PATH, lockMetadata)
  assert.equal(res.verified, true)
  assert.equal(res.service, 'kobralink')
  assert.equal(res.commit, '5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1')
  assert.equal(res.shortSha, '5a5e5d9b1e3b')

  const parsed = parseComposeRecipe(repoComposeText) as {
    services: { kobralink: Record<string, unknown> }
  }
  const svc = parsed.services.kobralink
  assert.deepEqual(svc.ports, ['127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}:7100'])
  assert.deepEqual(svc.security_opt, ['no-new-privileges:true'])
  assert.deepEqual(svc.cap_drop, ['ALL'])
})

test('verifyComposeRecipe rejects non-loopback binds, Moonraker ports, privilege escalations and unsupported env vars', () => {
  // Reject wildcard 0.0.0.0 bind
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          '127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}:7100',
          '0.0.0.0:${KOBRALINK_MGMT_PORT:-7100}:7100',
        ),
      ),
    /Management port must map strictly to 127\.0\.0\.1/,
  )

  // Reject Moonraker port range publishing
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          "      - '127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}:7100'",
          "      - '127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}:7100'\n      - '127.0.0.1:7125-7140:7125-7140'",
        ),
      ),
    /must publish only a single loopback management port/,
  )

  // Reject individual Moonraker port mapping
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          '127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}:7100',
          '127.0.0.1:7125:7125',
        ),
      ),
    /Management port must map strictly to 127\.0\.0\.1/,
  )

  // Reject host networking
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          '    restart: unless-stopped',
          '    restart: unless-stopped\n    network_mode: host',
        ),
      ),
    /Host networking, privileged mode and host namespace sharing are forbidden/,
  )

  // Reject privileged container
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          '    restart: unless-stopped',
          '    restart: unless-stopped\n    privileged: true',
        ),
      ),
    /Host networking, privileged mode and host namespace sharing are forbidden/,
  )

  // Reject docker.sock mount
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          '      - openfarm-kobralink-data:/data',
          '      - openfarm-kobralink-data:/data\n      - /var/run/docker.sock:/var/run/docker.sock',
        ),
      ),
    /must mount only the dedicated volume/,
  )

  // Reject unsupported upstream environment variable (e.g., KOBRALINK_BIND)
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          '      KOBRALINK_PORT: 7100',
          '      KOBRALINK_PORT: 7100\n      KOBRALINK_BIND: 0.0.0.0',
        ),
      ),
    /Unsupported upstream environment variable in Compose: KOBRALINK_BIND/,
  )

  // Reject non-empty KOBRALINK_UPDATE_REPO or KOBRALINK_EXTRA_ORIGINS
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          "      KOBRALINK_UPDATE_REPO: ''",
          "      KOBRALINK_UPDATE_REPO: 'NatHacks/Kobralink'",
        ),
      ),
    /Service environment violates isolation/,
  )
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace(
          "      KOBRALINK_EXTRA_ORIGINS: ''",
          "      KOBRALINK_EXTRA_ORIGINS: 'http://localhost:5173'",
        ),
      ),
    /Service environment violates isolation/,
  )

  // Reject shared Open3DFarmManager secret
  assert.throws(
    () =>
      checkModifiedCompose((c) =>
        c.replace('KOBRALINK_AUTH_SECRET:?', 'O3DFM_AUTH_SECRET:?'),
      ),
    /Service environment violates isolation/,
  )
})

test('assertExternalDestination rejects repository paths, symlinks, non-directories and non-owned directories', () => {
  assert.throws(
    () => assertExternalDestination(REPOSITORY_ROOT),
    /Destination must stay strictly outside Open3DFarmManager/,
  )
  assert.throws(
    () =>
      assertExternalDestination(join(REPOSITORY_ROOT, 'infra/kobralink/sub')),
    /Destination must stay strictly outside Open3DFarmManager/,
  )

  const tempDir = mkdtempSync(join(tmpdir(), 'o3dfm-test-dest-'))
  try {
    // Reject symlink destination
    const realTarget = join(tempDir, 'real-dir')
    mkdirSync(realTarget)
    const symlinkDir = join(tempDir, 'symlink-dir')
    symlinkSync(realTarget, symlinkDir)
    assert.throws(
      () => assertExternalDestination(symlinkDir),
      /Symbolic link is not permitted/,
    )

    // Reject child path under a symlinked parent directory
    assert.throws(
      () => assertExternalDestination(join(symlinkDir, 'child')),
      /Symbolic link is not permitted/,
    )

    // Reject file (non-directory) destination
    const filePath = join(tempDir, 'plain-file')
    writeFileSync(filePath, 'hello')
    assert.throws(() => assertExternalDestination(filePath), /not a directory/)

    // Reject non-owned destination directory via synthetic expectedUid
    const currentUid =
      typeof process.getuid === 'function' ? process.getuid() : 1000
    assert.throws(
      () =>
        assertExternalDestination(realTarget, {
          expectedUid: currentUid + 1,
        }),
      /not owned by the current user/,
    )

    // Accept valid owned external directory
    const valid = assertExternalDestination(realTarget, {
      expectedUid: currentUid,
    })
    assert.ok(!valid.startsWith(REPOSITORY_ROOT))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('verifyCheckout and cloneOrFetch enforce pin, cleanliness, origin and idempotent refusal', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'o3dfm-test-checkout-'))
  try {
    const { repoDir, commit, lock } = createSyntheticUpstreamRepo(tempDir)

    // 1. Clean checkout at pinned commit succeeds
    const verified = await verifyCheckout(repoDir, lock)
    assert.equal(verified.verified, true)
    assert.equal(verified.commit, commit)
    assert.equal(verified.version, '0.5.0')

    // 2. cloneOrFetch on an already-verified clean pinned checkout is idempotent
    const idempotent = await cloneOrFetch(repoDir, lock)
    assert.equal(idempotent.verified, true)
    assert.equal(idempotent.commit, commit)

    // 3. Mismatched commit is refused by both verifyCheckout and cloneOrFetch
    const wrongLock: LockMetadata = {
      ...lock,
      upstream: {
        ...lock.upstream,
        commit: '0000000000000000000000000000000000000000',
      },
    }
    await assert.rejects(
      () => verifyCheckout(repoDir, wrongLock),
      /Commit mismatch/,
    )
    await assert.rejects(
      () => cloneOrFetch(repoDir, wrongLock),
      /Commit mismatch/,
    )

    // 4. Dirty working tree (untracked file) is refused idempotently without deleting the file
    const untrackedFile = join(repoDir, 'untracked.txt')
    writeFileSync(untrackedFile, 'dirty-state')
    await assert.rejects(
      () => verifyCheckout(repoDir, lock),
      /dirty or modified/,
    )
    await assert.rejects(() => cloneOrFetch(repoDir, lock), /dirty or modified/)
    assert.equal(
      readFileSync(untrackedFile, 'utf8'),
      'dirty-state',
      'Refusal must not delete or modify untracked user files',
    )
    rmSync(untrackedFile)

    // 5. Foreign non-git non-empty directory is refused without altering contents
    const foreignDir = join(tempDir, 'foreign-dir')
    mkdirSync(foreignDir)
    const markerFile = join(foreignDir, 'keep.txt')
    writeFileSync(markerFile, 'preserve-me')
    await assert.rejects(
      () => cloneOrFetch(foreignDir, lock),
      /not a git repository/,
    )
    assert.equal(readFileSync(markerFile, 'utf8'), 'preserve-me')

    // 6. Foreign git remote URL is refused
    const { repoDir: foreignRepo, lock: foreignLock } =
      createSyntheticUpstreamRepo(join(tempDir, 'other'), {
        remoteUrl: 'https://github.com/example/other-repo.git',
      })
    await assert.rejects(
      () => verifyCheckout(foreignRepo, foreignLock),
      /Origin repository mismatch/,
    )

    // 7. Also verify read-only external upstream-kobralink archive if present on host
    const hostUpstream =
      '/Users/heitor/Developer/open3dfarmmanager-plans/2026-11-13-kobralink-execution/upstream-kobralink'
    if (existsSync(hostUpstream)) {
      const hostRes = await verifyCheckout(hostUpstream, lockMetadata)
      assert.equal(hostRes.verified, true)
      assert.equal(hostRes.commit, '5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1')
      assert.equal(hostRes.version, '0.5.0')
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
