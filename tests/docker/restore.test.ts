import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test(
  'restore rolls back data, rejects prior sessions and browser keys, and refuses newer schema',
  {
    skip:
      process.env.OPENFARM_DOCKER_RESTORE !== '1' &&
      'Set OPENFARM_DOCKER_RESTORE=1',
    timeout: 120_000,
  },
  async (t) => {
    const { default: postgres } = await import('postgres')
    const { PostgresSessionRepository } =
      await import('../../apps/farm/server/storage/postgres-session.ts')
    const { loadMigrationCatalog, runMigrations } =
      await import('../../scripts/db/migrations.ts')
    const { restore } = await import('../../scripts/self-host/restore.ts')
    const { openTrustedKeyStore } =
      await import('../../packages/connector/src/auth/trusted-key-store.ts')
    const { encodeTrustedKeySetFrame, signTrustedKeySet } =
      await import('../../packages/farm-protocol/src/trusted-keys.ts')
    const { validateBrowserDevicePublicKey } =
      await import('../../packages/farm-protocol/src/browser-device-proof.ts')
    const image =
      'postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
    const container = 'openfarm-249-' + randomUUID()
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'openfarm-249-'))
    const docker = (args: string[]) =>
      execFileSync('docker', args, { timeout: 45_000 })
    if (process.env.OPENFARM_RESTORE_LEDGER)
      appendFileSync(
        process.env.OPENFARM_RESTORE_LEDGER,
        `\nOwned container ${container}; directory ${directory}\n`,
      )
    t.after(() => rmSync(directory, { recursive: true }))
    const id = docker([
      'run',
      '-d',
      '--pull=never',
      '--name',
      container,
      '-p',
      '127.0.0.1::5432',
      '-e',
      'POSTGRES_PASSWORD=restore-fixture',
      '-e',
      'POSTGRES_DB=source',
      image,
    ])
      .toString()
      .trim()
    const pools: { end(options: { timeout: number }): Promise<void> }[] = []
    t.after(async () => {
      try {
        await Promise.all(pools.map((pool) => pool.end({ timeout: 0 })))
      } finally {
        docker(['rm', '-fv', id])
      }
    })
    if (process.env.OPENFARM_RESTORE_LEDGER) {
      const volumes = docker([
        'inspect',
        '--format',
        '{{range .Mounts}}{{.Name}} {{end}}',
        id,
      ])
      appendFileSync(
        process.env.OPENFARM_RESTORE_LEDGER,
        `Container ${id}; volumes ${volumes}`,
      )
    }
    docker(['start', id])
    const port = Number(
      docker(['port', container, '5432/tcp'])
        .toString()
        .trim()
        .split(':')
        .at(-1),
    )
    const connect = (database: string) =>
      postgres({
        host: '127.0.0.1',
        port,
        username: 'postgres',
        password: 'restore-fixture',
        database,
        max: 1,
        connect_timeout: 2,
      })
    const source = connect('source')
    pools.push(source)
    for (let attempt = 0; ; attempt++) {
      try {
        await source`SELECT 1`
        break
      } catch (error) {
        if (attempt >= 29) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    const catalog = await loadMigrationCatalog()
    // Model a backup from the first release with the browser trust schema.
    const backupCatalog = catalog.slice(0, 13)
    await runMigrations(source, backupCatalog, { kind: 'up' })
    const farm = randomUUID()
    const agent = randomUUID()
    const browser = randomUUID()
    const now = Date.now()
    await source`INSERT INTO farm.session_accounts (id) VALUES ('owner')`
    await source`INSERT INTO farm.account_sessions VALUES ('old', 'owner', 0, ${now}, ${now}, ${now + 600000}, NULL)`
    await source`INSERT INTO farm.farms VALUES (${farm})`
    const device = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
      'jwk',
      device.publicKey,
    )
    const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
      kty,
      crv,
      x,
      y,
    })
    await source`INSERT INTO farm.browser_device_keys (key_id, farm_id, account_id, public_key, thumbprint, created_at)
      VALUES (${browser}, ${farm}, 'owner', ${source.json(publicKey)}, ${thumbprint}, ${now})`
    const issuer = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const anchor = {
      issuer: 'farm:issuer',
      kid: 'issuer-1',
      publicKey: issuer.publicKey,
    }
    const storeOptions = {
      path: join(directory, 'keys.json'),
      farmId: farm,
      issuers: [anchor],
    }
    const browserGrant = {
      farm_id: farm,
      account_id: 'owner',
      key_id: browser,
      browser_thumbprint: thumbprint,
    }
    const store = await openTrustedKeyStore(storeOptions)
    const keySet = await signTrustedKeySet(
      {
        v: 1,
        purpose: 'trusted-key-set',
        farm_id: farm,
        version: 500,
        issued_at: now,
        issuer: anchor.issuer,
        kid: anchor.kid,
        issuer_keys: [
          {
            issuer: anchor.issuer,
            kid: anchor.kid,
            public_key_spki: Buffer.from(
              await crypto.subtle.exportKey('spki', issuer.publicKey),
            ).toString('base64url'),
          },
        ],
        browser_keys: [
          {
            key_id: browser,
            account_id: 'owner',
            thumbprint,
            public_key: publicKey,
          },
        ],
      },
      issuer.privateKey,
    )
    assert.equal(
      await store.confirm(
        encodeTrustedKeySetFrame({
          v: 1,
          t: 'trusted-keys.set',
          key_set: keySet,
        }),
      ),
      true,
    )
    assert.equal(
      (await openTrustedKeyStore(storeOptions)).authority.allowsBrowser(
        browserGrant,
      ),
      true,
    )
    await source`UPDATE farm.browser_device_keys SET status = 'approved', proof_at = ${now},
    proof_session_id = 'old', approved_at = ${now}, approved_by = 'owner' WHERE key_id = ${browser}`
    const dump = (file: string) =>
      writeFileSync(
        file,
        docker([
          'exec',
          container,
          'pg_dump',
          '-Fc',
          '-U',
          'postgres',
          '-d',
          'source',
        ]),
        { mode: 0o600 },
      )
    const archive = join(directory, 'backup.dump')
    dump(archive)
    const sessions = new PostgresSessionRepository(source)
    const policy = { idleTimeoutMs: 300_000 }
    assert.equal(
      (await sessions.authorizeAndTouch('old', Date.now(), policy)).ok,
      true,
    )
    await source`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = 'old'`
    await source`INSERT INTO farm.session_accounts (id) VALUES ('after_backup')`
    const config = join(directory, 'backup.json')
    const target = join(directory, 'restored.json')
    const settings = {
      version: 1,
      mode: 'configuration-provisioning',
      farm_id: farm,
      agent_id: agent,
      farmOrigin: 'https://farm.example',
      credentialAudience: 'fixture',
      stateDirectory: directory,
      runtimeConfigPath: join(directory, 'runtime.json'),
      printerNetworks: ['192.168.1.0/24'],
      managedBridge: null,
      runtimeTemplate: { telemetry: {} },
    }
    writeFileSync(config, JSON.stringify(settings), { mode: 0o600 })
    const marker = join(directory, 'trusted-keys.epoch')
    execFileSync(
      process.execPath,
      [
        'scripts/self-host/restore.ts',
        'restore',
        container,
        'restored',
        archive,
        'provisioning',
        config,
        target,
        directory,
      ],
      { timeout: 45_000 },
    )
    const restored = connect('restored')
    pools.push(restored)
    assert.deepEqual(
      await new PostgresSessionRepository(restored).authorizeAndTouch(
        'old',
        Date.now(),
        policy,
      ),
      { ok: false, reason: 'revoked' },
    )
    assert.deepEqual(
      [
        ...(await restored`SELECT id, session_version::int FROM farm.session_accounts`),
      ],
      [{ id: 'owner', session_version: 1 }],
    )
    assert.equal(
      (
        await restored`SELECT status FROM farm.browser_device_keys WHERE key_id = ${browser}`
      )[0]?.status,
      'revoked',
    )
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), settings)
    const restartedStore = await openTrustedKeyStore(storeOptions)
    assert.equal(restartedStore.authority.allowsBrowser(browserGrant), false)
    assert.equal(restartedStore.version, undefined)
    const epoch = readFileSync(marker, 'utf8')

    // Simulate a dump from a newer release without applying unrelated migrations.
    for (const [index, migration] of catalog.entries()) {
      if (index < backupCatalog.length) continue
      await source`INSERT INTO public.open3dfarm_migrations VALUES (${index + 1}, ${migration.id}, ${migration.checksum})`
    }
    await source`INSERT INTO public.open3dfarm_migrations VALUES (${catalog.length + 1}, 'future', ${'a'.repeat(64)})`
    await source`CREATE TABLE farm.future_schema (id integer)`
    const newer = join(directory, 'newer.dump')
    dump(newer)
    const newerTarget = join(directory, 'newer.json')
    await assert.rejects(
      restore(container, 'newer', newer, 'provisioning', config, newerTarget, [
        directory,
      ]),
      /schema is newer/,
    )
    assert.equal(readFileSync(marker, 'utf8'), epoch)
    assert.equal(existsSync(newerTarget), false)
    assert.equal(
      (await source`SELECT 1 FROM pg_database WHERE datname = 'newer'`).length,
      0,
    )
  },
)
