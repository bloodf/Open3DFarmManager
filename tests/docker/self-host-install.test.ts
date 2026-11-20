import assert from 'node:assert/strict'
import {
  execFileSync,
  spawn,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { request as upstream } from 'node:http'
import { createServer, request } from 'node:https'
import { createServer as createSocket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import { test } from 'node:test'

async function listen(server: ReturnType<typeof createSocket>) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      resolve(address.port)
    })
  })
}

async function close(server: ReturnType<typeof createSocket>) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

test(
  'fresh Compose install signs in the first owner and pairs a simulator Connector identity',
  {
    skip: process.env.OPENFARM_INSTALL_REHEARSAL !== '1',
    timeout: 360_000,
  },
  async (t) => {
    const project = 'openfarm-install-' + randomBytes(6).toString('hex')
    const dir = mkdtempSync(join(tmpdir(), project + '-'))
    const deployment = join(dir, 'state')
    const ledger =
      process.env.OPENFARM_INSTALL_LEDGER || join(dir, 'ownership.log')
    const suppliedImage = process.env.OPENFARM_INSTALL_IMAGE
    const image = suppliedImage || `${project}:local`
    const composeSource = 'infra/app/docker-compose.yml'
    const postgresImage = readFileSync(composeSource, 'utf8').match(
      /^    image: (postgres:[^\s]+)$/m,
    )?.[1]
    assert.ok(postgresImage, 'Expected the pinned Compose PostgreSQL image')
    const imageExists = (ref: string) =>
      spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' })
        .status === 0
    const run = (
      command: string,
      args: string[],
      options: Partial<ExecFileSyncOptionsWithStringEncoding> = {},
    ) =>
      execFileSync(command, args, {
        timeout: 150_000,
        encoding: 'utf8',
        ...options,
      })
    // Resolve the caller's local candidate before Compose can pull anything.
    const composeEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(COMPOSE_|O3DFM_|NUXT_)/.test(key),
      ),
    )
    const composeWith = (files: string[], ...args: string[]) =>
      run(
        'docker',
        [
          'compose',
          '--env-file',
          join(dir, '.env'),
          '-p',
          project,
          ...files.flatMap((file) => ['-f', join(dir, file)]),
          ...args,
        ],
        {
          env: composeEnv,
        },
      )
    const compose = (...args: string[]) => composeWith(['compose.yml'], ...args)
    const pairedCompose = (...args: string[]) =>
      composeWith(['compose.yml', 'pairing.compose.yml'], ...args)
    let configured = false
    let builderCreated = false
    let postgresWasPresent = true
    const cleanupProject = () => {
      if (!configured) return
      composeEnv.O3DFM_APP_ENV_FILE = '/dev/null'
      compose('down', '--volumes', '--remove-orphans')
      for (const kind of ['container', 'network', 'volume']) {
        assert.equal(
          run('docker', [
            kind,
            'ls',
            ...(kind === 'container' ? ['-a'] : []),
            '-q',
            '--filter',
            `label=com.docker.compose.project=${project}`,
          ]).trim(),
          '',
        )
      }
    }
    t.after(() => {
      const errors: unknown[] = []
      for (const clean of [
        cleanupProject,
        () => {
          if (builderCreated) run('docker', ['buildx', 'rm', project])
        },
        () => {
          if (!suppliedImage && imageExists(image))
            run('docker', ['image', 'rm', image])
        },
        () => {
          if (
            !postgresWasPresent &&
            imageExists(postgresImage) &&
            !run('docker', [
              'ps',
              '-aq',
              '--filter',
              `ancestor=${postgresImage}`,
            ]).trim()
          ) {
            run('docker', ['image', 'rm', postgresImage])
          }
        },
        () => rmSync(dir, { recursive: true, force: true }),
      ]) {
        try {
          clean()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Rehearsal cleanup failed')
      t.diagnostic(
        `Cleaned rehearsal project ${project}; ${run('df', ['-h', '.']).trim().split('\n').at(-1)}`,
      )
    })
    // Record ownership and the pre-run state outside the checkout.
    writeFileSync(
      ledger,
      [
        `Project ${project}; scratch ${dir}; volumes ${project}-data; network ${project}-net`,
        suppliedImage
          ? `Existing app image ${image}`
          : `Owned builder ${project} and app image ${image}`,
        run('df', ['-h', '.']),
        run('git', ['status', '--short']),
        run('git', ['worktree', 'list']),
        run('docker', ['ps', '-a']),
        run('docker', ['image', 'ls', '--digests']),
        run('docker', ['volume', 'ls']),
        run('docker', ['network', 'ls']),
      ].join('\n'),
      { flag: 'a', mode: 0o600 },
    )
    postgresWasPresent = imageExists(postgresImage)
    if (!suppliedImage) {
      run('docker', [
        'buildx',
        'create',
        '--driver',
        'docker-container',
        '--name',
        project,
      ])
      builderCreated = true
      run(
        'docker',
        [
          'buildx',
          'build',
          '--builder',
          project,
          '--load',
          '-f',
          'apps/farm/Dockerfile',
          '-t',
          image,
          '.',
        ],
        { timeout: 240_000 },
      )
    }
    const imageId = run('docker', [
      'image',
      'inspect',
      image,
      '--format',
      '{{.Id}}',
    ]).trim()
    const appSocket = createSocket()
    const dbSocket = createSocket()
    const appPort = await listen(appSocket)
    const dbPort = await listen(dbSocket)
    await Promise.all([close(appSocket), close(dbSocket)])

    const cert = join(dir, 'tls.crt')
    const key = join(dir, 'tls.key')
    run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'pipe' },
    )
    const ca = readFileSync(cert)
    const proxy = createServer(
      { cert: ca, key: readFileSync(key) },
      (req, res) => {
        if (req.url === '/readyz') {
          res.writeHead(404).end()
          return
        }
        const { connection: _connection, ...headers } = req.headers
        const forwarded = upstream(
          {
            agent: false,
            hostname: '127.0.0.1',
            port: appPort,
            method: req.method,
            path: req.url,
            headers: { ...headers, 'x-forwarded-proto': 'https' },
          },
          (response) => {
            const headers = { ...response.headers }
            delete headers.connection
            delete headers['keep-alive']
            delete headers['transfer-encoding']
            if (req.url?.startsWith('/api/connector-pairing/'))
              t.diagnostic(`${req.url} returned HTTP ${response.statusCode}`)
            res.writeHead(response.statusCode ?? 502, headers)
            response.pipe(res)
          },
        )
        forwarded.on('error', () => res.writeHead(502).end())
        req.pipe(forwarded)
      },
    )
    const origin = `https://127.0.0.1:${await listen(proxy)}`
    t.after(() => close(proxy))
    const password = randomBytes(24).toString('hex')
    const database = 'rehearsal'
    const admin = 'bootstrap_admin'
    const migratorPassword = randomBytes(24).toString('hex')
    copyFileSync(composeSource, join(dir, 'compose.yml'))
    copyFileSync(
      'infra/app/pairing.compose.yml',
      join(dir, 'pairing.compose.yml'),
    )
    writeFileSync(
      join(dir, '.env'),
      [
        `O3DFM_APP_IMAGE=${imageId}`,
        `O3DFM_DB_PASSWORD=${password}`,
        `O3DFM_DB_NAME=${database}`,
        `O3DFM_DB_USER=${admin}`,
        `O3DFM_APP_PORT=${appPort}`,
        `O3DFM_DB_PORT=${dbPort}`,
        'NUXT_DATABASE_MIGRATIONS=verify',
        'O3DFM_APP_ENV_FILE=./state/app.env',
        `O3DFM_OPERATOR_UID=${process.getuid?.()}`,
        `O3DFM_OPERATOR_GID=${process.getgid?.()}`,
      ].join('\n'),
      { mode: 0o600 },
    )
    configured = true
    composeEnv.O3DFM_APP_ENV_FILE = '/dev/null'
    compose('up', '-d', '--wait', 'postgres')
    const psql = (sql: string) =>
      run(
        'docker',
        [
          'exec',
          '-i',
          compose('ps', '-q', 'postgres').trim(),
          'psql',
          '-XAt',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          admin,
          '-d',
          database,
        ],
        { input: sql },
      )
    psql(`CREATE ROLE o3dfm_migrator LOGIN PASSWORD '${migratorPassword}' NOSUPERUSER CREATEROLE;
    ALTER ROLE o3dfm_migrator SET createrole_self_grant = 'set, inherit';
    GRANT CREATE ON DATABASE ${database} TO o3dfm_migrator;
    GRANT CREATE ON SCHEMA public TO o3dfm_migrator;`)
    const migrate = `${project}-migrate`
    composeEnv.NUXT_DATABASE_DATABASE_URL = `postgres://o3dfm_migrator:${migratorPassword}@postgres:5432/${database}`
    try {
      compose(
        'run',
        '-d',
        '--name',
        migrate,
        '--no-deps',
        '--pull',
        'never',
        '-e',
        'NUXT_DATABASE_MIGRATIONS=apply',
        '-e',
        'NUXT_DATABASE_DATABASE_URL',
        'app',
      )
      let ready = false
      for (let i = 0; i < 45 && !ready; i++) {
        try {
          run(
            'docker',
            [
              'exec',
              migrate,
              'node',
              '-e',
              "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1))",
            ],
            { stdio: 'ignore' },
          )
          ready = true
        } catch {
          await delay(1000)
        }
      }
      if (!ready)
        t.diagnostic(
          run('docker', ['logs', migrate], {
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        )
      assert.ok(ready, 'migration owner did not reach readiness')
    } finally {
      delete composeEnv.NUXT_DATABASE_DATABASE_URL
      delete composeEnv.O3DFM_APP_ENV_FILE
      run('docker', ['rm', '-f', migrate])
    }
    run(
      process.execPath,
      ['scripts/self-host/init.ts', deployment, origin, '--compose'],
      {
        env: {
          ...process.env,
          OPENFARM_INIT_DATABASE_URL: `postgres://${admin}:${password}@127.0.0.1:${dbPort}/${database}`,
        },
      },
    )
    const generated = join(deployment, 'app.env')
    const env = parseEnv(readFileSync(generated, 'utf8'))
    assert.equal(statSync(deployment).mode & 0o777, 0o700)
    for (const name of [
      'app.env',
      'pairing.pem',
      'renewal.pem',
      'pause.json',
      'verification-keys.json',
    ]) {
      assert.equal(statSync(join(deployment, name)).mode & 0o777, 0o600)
    }
    assert.equal(env.NUXT_AUTH_ORIGIN, origin)
    assert.equal(env.NUXT_DATABASE_MIGRATIONS, 'verify')
    assert.equal(env.NUXT_DATABASE_MIGRATIONS_DIR, '/app/migrations')
    const required = (name: string) => {
      const value = env[name]
      assert.ok(value, `Initializer did not set ${name}`)
      return value
    }
    const bootstrapToken = required('NUXT_AUTH_BOOTSTRAP_TOKEN')
    assert.ok(required('NUXT_AUTH_SESSION_SECRET').length >= 32)
    assert.ok(bootstrapToken.length >= 32)
    assert.equal(env.NUXT_AUTH_ENABLED, 'true')
    assert.equal(env.NUXT_DATABASE_ENABLED, 'true')
    for (const name of Object.keys(env).filter((name) =>
      name.endsWith('_DATABASE_URL'),
    )) {
      const url = new URL(required(name))
      assert.match(url.username, /^o3dfm_[a-f0-9]{16}_/)
      assert.equal(url.host, 'postgres:5432')
    }
    assert.deepEqual(
      Object.keys(env)
        .filter((name) => name.endsWith('_ENABLED'))
        .sort(),
      ['NUXT_AUTH_ENABLED', 'NUXT_DATABASE_ENABLED'],
    )
    compose('up', '-d', '--wait', '--pull', 'never', 'app')
    assert.equal(
      (await fetch(`http://127.0.0.1:${appPort}/readyz`)).status,
      200,
    )

    const https = (
      path: string,
      options: {
        body?: string
        headers?: Record<string, string>
        method?: string
        signal?: AbortSignal
      } = {},
    ) =>
      new Promise<{ status: number; body: string; cookies: string[] }>(
        (resolve, reject) => {
          const req = request(
            origin + path,
            {
              ca,
              agent: false,
              method: options.method,
              headers: options.headers,
              signal: options.signal,
            },
            (res) => {
              res.setEncoding('utf8')
              let body = ''
              res.on('data', (chunk) => {
                body += chunk
              })
              res.on('error', reject)
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body,
                  cookies: res.headers['set-cookie'] ?? [],
                }),
              )
            },
          )
          req.on('error', reject)
          req.setTimeout(10_000, () =>
            req.destroy(new Error('HTTPS request timed out')),
          )
          req.end(options.body)
        },
      )
    const post = (path: string, body: object, headers = {}) =>
      https(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { origin, 'content-type': 'application/json', ...headers },
      })
    assert.equal((await https('/primeiro-acesso')).status, 200)
    assert.equal((await https('/readyz')).status, 404)
    const credentials = { username: 'rehearsal_owner', password }
    const bootstrap = await post('/api/auth/bootstrap', credentials, {
      'x-bootstrap-token': bootstrapToken,
    })
    assert.equal(bootstrap.status, 200, 'first owner bootstrap')
    assert.equal(
      (
        await post(
          '/api/auth/bootstrap',
          { ...credentials, username: 'second_owner' },
          { 'x-bootstrap-token': env.NUXT_AUTH_BOOTSTRAP_TOKEN },
        )
      ).status,
      400,
    )
    const login = await post('/api/auth/login', credentials)
    assert.equal(login.status, 200, 'independent owner sign-in')
    const session = login.cookies.find((value) => /;\s*HttpOnly/i.test(value))
    assert.ok(
      session && /;\s*Secure/i.test(session) && !/;\s*Domain=/i.test(session),
    )
    const [cookie] = session.split(';')
    assert.ok(cookie)
    const headers = { cookie }
    const me = await https('/api/auth/me', { headers })
    assert.equal(me.status, 200)
    assert.equal(
      JSON.parse(me.body).accountId,
      JSON.parse(bootstrap.body).accountId,
    )
    pairedCompose('up', '-d', '--wait', '--pull', 'never', 'app')
    const farms = await https('/api/farms', { headers })
    assert.equal(farms.status, 200)
    const [farm] = JSON.parse(farms.body).farms
    assert.equal(psql('SELECT role FROM farm.memberships;').trim(), 'owner')
    const farmId = farm.farmId
    assert.equal(typeof farmId, 'string')
    const { normalizePairingCode } =
      await import('../../packages/farm-protocol/src/pairing.ts')
    const { startMoonrakerMock } =
      await import('../../packages/sim-tools/src/mocks/moonraker-mock.ts')
    const { readMoonrakerReady } =
      await import('../../packages/connector/src/moonraker/client.ts')
    const simulator = await startMoonrakerMock()
    t.after(() => simulator.close())
    await readMoonrakerReady({
      origin: simulator.origin,
      limits: {
        requestTimeoutMs: 2000,
        maxMessageBytes: 65536,
        connectTimeoutMs: 2000,
        staleAfterMs: 3000,
        reconnectMinMs: 100,
        reconnectMaxMs: 1000,
      },
      signal: AbortSignal.timeout(3000),
    })
    const dataDir = join(dir, 'simulator-connector')
    const credentialPath = join(dataDir, 'credential.json')
    const cli = 'packages/connector/src/cli.ts'
    run(process.execPath, [cli, 'init-identity', '--data-dir', dataDir])
    const identity = JSON.parse(
      run(process.execPath, [cli, 'identity', '--data-dir', dataDir]),
    )
    const connector = spawn(
      process.execPath,
      [
        cli,
        'pair',
        '--server',
        origin,
        '--audience',
        required('NUXT_CONNECTOR_PAIRING_AUDIENCE'),
        '--data-dir',
        dataDir,
        '--credential-file',
        credentialPath,
      ],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        signal: AbortSignal.timeout(30_000),
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    const lines = createInterface({ input: connector.stdout })
    try {
      await Promise.all([
        once(connector, 'close').then(([exitCode]) => {
          assert.equal(exitCode, 0, 'Connector pairing CLI exit code')
        }),
        (async () => {
          let code: string | undefined
          for await (const line of lines) {
            code ??= /^\s+Código: (.+)$/.exec(line)?.[1]
            const fingerprint = /^\s+Impressão digital: (.+)$/.exec(line)?.[1]
            if (!fingerprint) continue
            assert.ok(code, 'Connector printed a pairing code')
            assert.equal(fingerprint, identity.fingerprint)
            const result = await post(
              '/api/connector-pairing/approve',
              {
                user_code: normalizePairingCode(code),
                farm_id: farmId,
                expected_fingerprint: fingerprint,
              },
              headers,
            )
            assert.equal(result.status, 200, 'owner pairing approval')
          }
        })(),
      ])
    } finally {
      lines.close()
      if (connector.exitCode === null && connector.signalCode === null)
        connector.kill()
    }
    const credential = JSON.parse(readFileSync(credentialPath, 'utf8'))
    assert.equal(statSync(credentialPath).mode & 0o777, 0o600)
    assert.equal(credential.approval.farm_id, farmId)
    assert.equal(credential.expected_fingerprint, identity.fingerprint)
    const inventory = await https(`/api/farms/${farmId}/connectors`, {
      headers,
    })
    assert.equal(inventory.status, 200)
    assert.deepEqual(JSON.parse(inventory.body).connectors, [
      {
        agentId: credential.approval.agent_id,
        fingerprint: identity.fingerprint,
        status: 'approved',
      },
    ])
  },
)
