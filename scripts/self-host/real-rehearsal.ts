import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  realpathSync,
  statfsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyConnectorConfig } from '../connector-config-backup.ts'
import { snapshotSql } from './rehearse-upgrade.ts'
import { upgrade } from './upgrade.ts'

/** Opt-in only. Every Docker mutation is scoped to a fresh project or its image tags. */
export async function realRehearsal() {
  const project = `o3dfm-real-${randomUUID()}`
  const directory = mkdtempSync(join(realpathSync(tmpdir()), `${project}-`))
  const evidence =
    process.env.OPENFARM_REHEARSAL_EVIDENCE ?? directory + '-evidence'
  mkdirSync(evidence, { recursive: true, mode: 0o700 })
  let sequence = 0
  function run(
    command: string,
    args: string[],
    input?: string | Buffer,
  ): Buffer {
    const result = spawnSync(command, args, {
      input,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 900_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('COMPOSE_'),
        ),
      ),
    })
    writeFileSync(
      join(evidence, `${++sequence}.log`),
      Buffer.concat([
        result.stdout ?? Buffer.alloc(0),
        result.stderr ?? Buffer.alloc(0),
      ]),
      { mode: 0o600 },
    )
    if (result.error || result.status !== 0)
      throw new Error(
        `${command} ${args[0]} failed (${result.status}); evidence ${evidence}/${sequence}.log`,
        { cause: result.error },
      )
    return result.stdout
  }
  const git = (...args: string[]) => run('git', args).toString().trim()
  const previous = git('rev-parse', 'origin/main~1')
  const current = git('rev-parse', 'HEAD')
  assert.notEqual(previous, current)
  assert.equal(git('merge-base', '--is-ancestor', previous, current), '')
  const previousImage = `${project}:previous`
  const currentImage = `${project}:current`
  const manifest = join(directory, 'compose.json')
  const base = ['compose', '--project-name', project, '-f', manifest]
  const docker = (...args: string[]) => run('docker', args).toString().trim()
  const compose = (...args: string[]) => docker(...base, ...args)
  const sql = (query: string) =>
    run(
      'docker',
      [
        ...base,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-XqAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'rehearsal',
        '-d',
        'rehearsal',
      ],
      query,
    )
      .toString()
      .trim()
  const postgresImage =
    'postgres:17@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
  const db = 'postgres://rehearsal:rehearsal@postgres:5432/rehearsal'
  const token = randomUUID() + randomUUID()
  const baseline = {
    images: docker('image', 'ls', '--no-trunc', '--format', '{{.ID}}').split(
      '\n',
    ),
    containers: docker('ps', '-aq'),
    volumes: docker('volume', 'ls', '-q'),
    worktrees: git('worktree', 'list'),
    freeBytes: readFreeBytes(directory),
  }
  writeFileSync(
    join(evidence, 'baseline.json'),
    JSON.stringify(baseline, null, 2),
    { mode: 0o600 },
  )
  assert.ok(
    baseline.freeBytes > 10 * 1024 ** 3,
    'Need 10 GiB free for two builds',
  )
  function deployment(image: string) {
    return {
      name: project,
      services: {
        postgres: {
          image: postgresImage,
          environment: {
            POSTGRES_USER: 'rehearsal',
            POSTGRES_PASSWORD: 'rehearsal',
            POSTGRES_DB: 'rehearsal',
          },
          volumes: ['database:/var/lib/postgresql/data'],
          networks: ['isolated'],
          healthcheck: {
            test: ['CMD', 'pg_isready', '-U', 'rehearsal'],
            interval: '1s',
            timeout: '3s',
            retries: 60,
          },
        },
        app: {
          image,
          pull_policy: 'never',
          environment: {
            NUXT_DATABASE_ENABLED: 'true',
            NUXT_DATABASE_DATABASE_URL: db,
            NUXT_DATABASE_MIGRATIONS: 'apply',
            NUXT_AUTH_ENABLED: 'true',
            NUXT_AUTH_DATABASE_URL: db,
            NUXT_AUTH_ORIGIN: 'https://rehearsal.invalid',
            NUXT_AUTH_SESSION_SECRET: token,
            NUXT_AUTH_BOOTSTRAP_TOKEN: token,
          },
          networks: ['isolated'],
        },
        // A passive holder proves persistence without starting printer connections.
        connector: {
          image,
          pull_policy: 'never',
          entrypoint: ['node', '-e', 'setInterval(()=>{},1000)', '--'],
          command: ['--data-dir', '/connector'],
          volumes: ['connector:/connector'],
          networks: ['isolated'],
          user: '0:0',
        },
      },
      volumes: {
        database: { name: `${project}-database` },
        connector: { name: `${project}-connector` },
      },
      networks: { isolated: { name: `${project}-network`, internal: true } },
    }
  }
  function writeDeployment(image: string) {
    writeFileSync(manifest, JSON.stringify(deployment(image)), { mode: 0o600 })
  }
  async function ready() {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        compose(
          'exec',
          '-T',
          'app',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3000/readyz').then(async r=>{const b=await r.json();process.exit(r.ok&&b.checks?.database==='ok'?0:1)}).catch(()=>process.exit(1))",
        )
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    throw new Error('Application readiness timeout')
  }
  const digest = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex')
  const built: string[] = []
  let pulledPostgres = false
  let started = false
  let succeeded = false
  try {
    // A private BuildKit builder owns its cache; deleting it never prunes shared cache.
    docker(
      'buildx',
      'create',
      '--name',
      project,
      '--driver',
      'docker-container',
    )
    for (const [revision, image] of [
      [previous, previousImage],
      [current, currentImage],
    ]) {
      assert.ok(
        statfsSync(directory).bavail * statfsSync(directory).bsize >
          5 * 1024 ** 3,
      )
      const context = join(directory, revision!)
      mkdirSync(context)
      const archive = join(directory, revision! + '.tar')
      run('git', ['archive', '--output', archive, revision!])
      run('tar', ['-xf', archive, '-C', context])
      rmSync(archive)
      docker(
        'buildx',
        'build',
        '--builder',
        project,
        '--load',
        '-t',
        image!,
        '-f',
        join(context, 'apps/farm/Dockerfile'),
        context,
      )
      built.push(image!)
    }
    writeDeployment(previousImage)
    started = true
    compose('up', '-d', '--wait', '--wait-timeout', '120', 'postgres')
    pulledPostgres = !baseline.images.includes(
      docker('image', 'inspect', '--format', '{{.Id}}', postgresImage),
    )
    compose('up', '-d', 'app', 'connector')
    await ready()
    const createAccount = `const r=await fetch('http://127.0.0.1:3000/api/auth/bootstrap',{method:'POST',headers:{'content-type':'application/json',origin:'https://rehearsal.invalid','x-bootstrap-token':process.env.NUXT_AUTH_BOOTSTRAP_TOKEN},body:JSON.stringify({username:'rehearsal-owner',password:'rehearsal-password-unique-123'})});if(!r.ok)throw Error('bootstrap '+r.status);const b=await r.json();if(!b.accountId)throw Error('missing account');console.log(b.accountId)`
    const accountId = compose('exec', '-T', 'app', 'node', '-e', createAccount)
    assert.match(accountId, /^[a-f0-9-]{36}$/)
    const config = Buffer.from(
      JSON.stringify({
        version: 1,
        allowedOrigins: ['http://127.0.0.1:7125'],
        printers: [
          { printerKey: 'rehearsal', origin: 'http://127.0.0.1:7125' },
        ],
      }) + '\n',
    )
    const source = join(directory, 'collector.json')
    writeFileSync(source, config, { mode: 0o600 })
    compose(
      'exec',
      '-T',
      'connector',
      'node',
      '-e',
      `require('fs').writeFileSync('/connector/collector.json',Buffer.from('${config.toString('base64')}','base64'),{mode:0o600})`,
    )
    const readConfig = () =>
      Buffer.from(
        compose(
          'exec',
          '-T',
          'connector',
          'node',
          '-e',
          "console.log(require('fs').readFileSync('/connector/collector.json').toString('base64'))",
        ),
        'base64',
      )
    assert.deepEqual(readConfig(), config)
    writeFileSync(source, readConfig(), { mode: 0o600 })
    copyConnectorConfig(
      source,
      join(directory, 'collector.backup.json'),
      'collector',
    )

    compose('stop', 'app')
    const dataDigest = () =>
      digest(
        Buffer.from(
          sql(
            'SELECT jsonb_agg(value ORDER BY value::text)::text FROM (SELECT to_jsonb(t) AS value FROM farm.session_accounts t UNION ALL SELECT to_jsonb(t) FROM farm.password_credentials t UNION ALL SELECT to_jsonb(t) FROM farm.farms t UNION ALL SELECT to_jsonb(t) FROM farm.memberships t) s',
          ),
        ),
      )
    const beforeDataDigest = dataDigest()
    const before = JSON.parse(sql(snapshotSql)) as {
      counts: Record<string, string>
    }
    for (const table of [
      'farm.session_accounts',
      'farm.password_credentials',
      'farm.farms',
      'farm.memberships',
    ])
      assert.equal(before.counts[table], '1', table)
    writeDeployment(currentImage)
    const backup = join(directory, 'database.dump')
    await upgrade(
      {
        version: 'current',
        compose: manifest,
        backup,
        ready: 'http://127.0.0.1/readyz',
      },
      async (args, output) => {
        if (args[0] === 'ready') {
          await ready()
          return 'ok'
        }
        // These two images were built locally from immutable Git archives; no registry tag exists.
        if (args.at(-1) === 'pull') {
          docker('image', 'inspect', previousImage, currentImage)
          return ''
        }
        const result = run('docker', args)
        if (output) writeFileSync(output, result, { mode: 0o600, flag: 'wx' })
        return result.toString()
      },
      async () => {
        const s = statfsSync(directory)
        return s.bavail * s.bsize
      },
    )
    assert.equal(readFileSync(backup).subarray(0, 5).toString(), 'PGDMP')
    compose('stop', 'app')
    const after = JSON.parse(sql(snapshotSql)) as {
      counts: Record<string, string>
    }
    for (const [table, count] of Object.entries(before.counts))
      assert.equal(after.counts[table], count, table)
    assert.equal(dataDigest(), beforeDataDigest)
    assert.equal(digest(readConfig()), digest(config))
    copyConnectorConfig(
      join(directory, 'collector.backup.json'),
      join(directory, 'restored.json'),
      'collector',
    )
    assert.deepEqual(
      readFileSync(join(directory, 'restored.json')),
      readConfig(),
    )
    // Prove the product dump is restorable, independently of surviving live volumes.
    sql('CREATE DATABASE rehearsal_restore')
    run(
      'docker',
      [
        ...base,
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '-U',
        'rehearsal',
        '-d',
        'rehearsal_restore',
      ],
      readFileSync(backup),
    )
    const restored = run(
      'docker',
      [
        ...base,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-XqAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'rehearsal',
        '-d',
        'rehearsal_restore',
      ],
      snapshotSql,
    )
      .toString()
      .trim()
    assert.deepEqual(JSON.parse(restored), before)
    const report = {
      previous,
      current,
      previousImage,
      currentImage,
      accountId,
      before: before.counts,
      after: after.counts,
      configurationSha256: digest(config),
      dataSha256: beforeDataDigest,
      backupRestored: true,
    }
    writeFileSync(
      join(evidence, 'report.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    )
    console.log(JSON.stringify(report, null, 2))
    succeeded = true
    return report
  } finally {
    // Do not let a failed cleanup hide other cleanup attempts.
    const failures: unknown[] = []
    const cleanup = (action: () => void) => {
      try {
        action()
      } catch (error) {
        failures.push(error)
      }
    }
    if (started) {
      cleanup(() => {
        compose('logs', '--no-color')
      })
      cleanup(() => {
        compose('down', '--volumes', '--remove-orphans')
      })
    }
    cleanup(() => {
      docker('buildx', 'rm', project)
    })
    for (const image of built)
      cleanup(() => {
        docker('image', 'rm', image)
      })
    if (pulledPostgres)
      cleanup(() => {
        docker('image', 'rm', postgresImage)
      })
    cleanup(() => {
      assert.equal(
        docker(
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ),
        '',
      )
    })
    cleanup(() => {
      assert.equal(
        docker(
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ),
        '',
      )
    })
    cleanup(() => {
      assert.equal(
        docker('network', 'ls', '-q', '--filter', `name=^${project}-network$`),
        '',
      )
    })
    writeFileSync(
      join(evidence, 'cleanup.json'),
      JSON.stringify(
        {
          project,
          succeeded,
          failures: failures.map(String),
          freeBytes: statfsSync(directory).bavail * statfsSync(directory).bsize,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    if (!failures.length) rmSync(directory, { recursive: true, force: true })
    console.log(`Evidence: ${evidence}`)
    if (failures.length)
      throw new AggregateError(
        failures,
        `Cleanup incomplete; manifest retained at ${manifest}`,
      )
  }
}

function readFreeBytes(directory: string) {
  const override = process.env.OPENFARM_REHEARSAL_FREE_BYTES
  if (override !== undefined) {
    const bytes = Number(override)
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid free bytes')
    return bytes
  }
  const { bavail, bsize } = statfsSync(directory)
  return bavail * bsize
}
