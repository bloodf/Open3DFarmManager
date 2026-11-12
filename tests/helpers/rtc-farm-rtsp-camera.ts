// Task-owned RTSP camera resources for the RTC farm acceptance runner: the
// `rtsp` simulator profile under an exact compose project and loopback port,
// and a verified copy of the prebuilt ingest helper (see
// docs/CAMERA-END-TO-END-CHECKPOINT.md, "Reproducing the interop run").
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const RTSP_PATH = '/test'
const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

/** One RTSP DESCRIBE: ready only once the simulator's publisher is up. */
function describe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let reply = ''
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(2000, () => done(false))
    socket.on('error', () => done(false))
    socket.on('data', (chunk) => {
      reply += chunk.toString('latin1')
      if (reply.includes('\r\n')) done(reply.startsWith('RTSP/1.0 200'))
    })
    socket.on('connect', () =>
      socket.write(
        `DESCRIBE rtsp://127.0.0.1:${port}${RTSP_PATH} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`,
      ),
    )
  })
}

export async function startRtspCamera(input: {
  checkout: string
  workDir: string
  project: string
  port: number
  helper: string
  helperSha256: string
  ledger(value: object): void
}) {
  if (
    !isAbsolute(input.helper) ||
    !/^[a-f0-9]{64}$/.test(input.helperSha256) ||
    !/^o3dfm-[a-z0-9-]{1,60}$/.test(input.project)
  )
    throw new Error('Invalid RTSP camera resource request')
  if ((await sha256(input.helper)) !== input.helperSha256)
    throw new Error('Ingest helper SHA-256 mismatch')
  const helperPath = join(input.workDir, 'rtsp-ingest')
  await copyFile(input.helper, helperPath)
  await chmod(helperPath, 0o700)
  if ((await sha256(helperPath)) !== input.helperSha256)
    throw new Error('Ingest helper copy SHA-256 mismatch')
  input.ledger({ resource: 'rtsp-helper', path: helperPath })
  const override = join(input.workDir, 'rtsp-override.yml')
  await writeFile(
    override,
    `services:\n  rtsp:\n    ports: !override\n      - '127.0.0.1:${input.port}:8554'\n`,
    { mode: 0o600 },
  )
  const compose = (...args: string[]) =>
    exec(
      'docker',
      [
        'compose',
        '--project-name',
        input.project,
        '-f',
        join(input.checkout, 'infra/sim/docker-compose.yml'),
        '-f',
        override,
        '--profile',
        'rtsp',
        ...args,
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    )
  let started = false
  async function stop() {
    if (!started) return
    await compose('down', '--remove-orphans', '--timeout', '5')
    const left = (
      await exec('docker', [
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${input.project}`,
      ])
    ).stdout.trim()
    if (left) throw new Error('RTSP simulator containers remain')
    input.ledger({ removed: 'compose-project', project: input.project })
  }
  input.ledger({ resource: 'compose-project', project: input.project })
  started = true
  try {
    await compose('up', '--detach', '--pull', 'never', '--no-deps', 'rtsp')
    input.ledger({
      resource: 'compose-containers',
      project: input.project,
      ids: (await compose('ps', '-aq')).stdout.trim().split('\n'),
    })
    const deadline = Date.now() + 30000
    while (!(await describe(input.port))) {
      if (Date.now() > deadline) throw new Error('RTSP simulator not ready')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } catch (error) {
    await stop().catch(() => {})
    started = false
    throw error
  }
  return {
    env: {
      SIGNALLING_HTTPS_CAMERA: JSON.stringify({
        helperPath,
        helperSha256: input.helperSha256,
        rtspPort: input.port,
        rtspPath: RTSP_PATH,
      }),
    },
    stop,
  }
}
