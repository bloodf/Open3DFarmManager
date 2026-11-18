import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import postgres from 'postgres'
import { seedSandbox } from './sandbox-seed.ts'

const action = process.argv[2]
if (process.argv.length > 3 || (action && !['stop', 'down'].includes(action))) {
  throw new Error('Uso: node scripts/sandbox.ts [stop|down]')
}
const uid = process.getuid?.()
const gid = process.getgid?.()
if (uid === undefined || gid === undefined)
  throw new Error('O sandbox requer Docker local em um sistema Unix.')
const project =
  'o3dfm-sandbox-' +
  createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)
const state = join(tmpdir(), project + '-' + uid)
mkdirSync(state, { mode: 0o700, recursive: true })
const stateInfo = lstatSync(state)
if (
  !stateInfo.isDirectory() ||
  stateInfo.uid !== uid ||
  (stateInfo.mode & 0o077) !== 0
)
  throw new Error(
    'O diretório local do sandbox deve ser privado e pertencer ao usuário atual.',
  )
const lock = join(state, 'lock')
const fd = openSync(lock, 'wx', 0o600)
try {
  const endpoint =
    process.env.DOCKER_HOST ??
    execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8' },
    ).trim()
  if (!endpoint.startsWith('unix://'))
    throw new Error('O sandbox requer um daemon Docker local.')
  const passwordFile = join(state, 'db-password')
  if (!existsSync(passwordFile))
    writeFileSync(passwordFile, randomBytes(24).toString('hex'), {
      mode: 0o600,
    })
  const password = readFileSync(passwordFile, 'utf8')
  const docker = (args: string[], capture = false) =>
    execFileSync(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        'infra/sandbox/compose.yml',
        '--profile',
        'sandbox',
        ...args,
      ],
      {
        env: {
          ...process.env,
          SANDBOX_STATE: state,
          SANDBOX_UID: String(uid),
          SANDBOX_GID: String(gid),
          SANDBOX_DB_PASSWORD: password,
        },
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      },
    )
  if (action) {
    docker(action === 'down' ? ['down', '--volumes'] : ['stop'])
    if (action === 'down')
      for (const file of ['client.json', 'seed-started']) {
        const path = join(state, file)
        if (existsSync(path)) unlinkSync(path)
      }
  } else {
    const clientPath = join(state, 'client.json')
    const seedMarker = join(state, 'seed-started')
    if (existsSync(seedMarker) && !existsSync(clientPath)) {
      throw new Error(
        'Inicialização anterior incompleta. Execute node scripts/sandbox.ts down para recriar o sandbox.',
      )
    }
    const cert = join(state, 'tls.crt')
    if (!existsSync(clientPath)) {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:P-256',
          '-noenc',
          '-keyout',
          join(state, 'tls.key'),
          '-out',
          cert,
          '-days',
          '30',
          '-subj',
          '/CN=app',
          '-addext',
          'subjectAltName=DNS:app,IP:127.0.0.1',
        ],
        { stdio: 'inherit' },
      )
    }
    if (
      !existsSync('apps/farm/.output/server/index.mjs') ||
      !existsSync('packages/connector/dist/cli.js')
    )
      execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
    docker([
      'up',
      '-d',
      '--wait',
      '--no-recreate',
      'postgres',
      'klipper',
      'bambu',
    ])
    const port = (service: string, internal: number) => {
      const mapped = docker(['port', service, String(internal)], true).trim()
      const publicPort = Number(
        /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(mapped)?.[1],
      )
      if (!Number.isInteger(publicPort) || publicPort > 65535)
        throw new Error(`Mapeamento local indisponível para ${service}.`)
      return publicPort
    }
    if (!existsSync(clientPath)) {
      writeFileSync(seedMarker, '', { mode: 0o600 })
      const url = new URL(
        `postgres://sandbox_bootstrap:${password}@127.0.0.1:${port('postgres', 5432)}/sandbox`,
      )
      const sql = postgres(url.href, { max: 1, ssl: false })
      try {
        await seedSandbox(sql, url, state)
      } finally {
        await sql.end()
      }
    }
    docker([
      'up',
      '-d',
      '--wait',
      '--no-deps',
      '--force-recreate',
      'app',
      'connector',
    ])
    const baseUrl = `https://127.0.0.1:${port('app', 3000)}`
    const ca = readFileSync(cert)
    let ready = false
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      ready = await new Promise<boolean>((resolve) => {
        const probe = request(
          baseUrl + '/readyz',
          { ca, timeout: 1000 },
          (response) => {
            response.resume()
            resolve(response.statusCode === 200)
          },
        )
        probe.on('error', () => resolve(false))
        probe.on('timeout', () => probe.destroy())
        probe.end()
      })
      if (!ready) await setTimeout(1000)
    }
    if (!ready) {
      docker(['logs', '--tail', '30', 'app', 'connector'])
      throw new Error('O aplicativo do sandbox não ficou pronto.')
    }
    const credentials = JSON.parse(readFileSync(clientPath, 'utf8'))
    console.log(
      Object.entries({
        OPENFARM_SANDBOX_URL: baseUrl,
        OPENFARM_CLIENT_ID: credentials.clientId,
        OPENFARM_CLIENT_SECRET: credentials.clientSecret,
        OPENFARM_PRINTER_ID: credentials.printerId,
        NODE_EXTRA_CA_CERTS: cert,
      })
        .map(
          ([name, value]) =>
            `export ${name}='${String(value).replaceAll("'", "'\\''")}'`,
        )
        .join('\n'),
    )
    console.log(
      `# Moonraker: 127.0.0.1:${port('klipper', 7125)} | Bambu TLS: 127.0.0.1:${port('bambu', 9999)}`,
    )
  }
} finally {
  closeSync(fd)
  unlinkSync(lock)
}
