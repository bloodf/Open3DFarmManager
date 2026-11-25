// The pinned real Spoolman: one task-owned container per corpus, published
// on a loopback port only. The optional external-library fixture is served by a
// python http.server inside the same container (no host port, no network
// access to the outside is used: EXTERNAL_DB_URL points at 127.0.0.1).
import { randomBytes } from 'node:crypto'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import {
  createRunDir,
  followLogs,
  removeRunDir,
} from '../../../scripts/docker-run-lib.mjs'
import { docker, OWNER_LABEL, TASK } from './docker.mjs'

const FIXTURE_PORT = 8099
const runDirs = new Set()

/** Remove the fixture run directories, after their containers are gone. */
export async function removeFixtureDirs() {
  for (const runDir of runDirs) {
    await removeRunDir(runDir)
    runDirs.delete(runDir)
  }
}

/** `docker create` argv; fixtures are mounted from the run directory. */
export function upstreamCreateArgs({ name, image, fixtureDir }) {
  const args = [
    'create',
    '--rm',
    '--name',
    name,
    '--label',
    `${OWNER_LABEL}=${TASK}`,
    '--pull',
    'never',
    '--memory',
    '1g',
    '--cpus',
    '2',
    '-p',
    '127.0.0.1::8000',
    // Spoolman's data directory and scratch space never reach a volume.
    '--tmpfs',
    '/home/app/.local/share/spoolman:rw,mode=1777',
    '--tmpfs',
    '/tmp:rw,mode=1777',
    '-e',
    'SPOOLMAN_DEBUG_MODE=FALSE',
  ]
  if (fixtureDir) {
    args.push(
      '-v',
      `${fixtureDir}:/fx:ro`,
      '-e',
      `EXTERNAL_DB_URL=http://127.0.0.1:${FIXTURE_PORT}/`,
      '--entrypoint',
      'sh',
      image,
      '-c',
      `python -m http.server ${FIXTURE_PORT} --bind 127.0.0.1 --directory /fx >/dev/null 2>&1 & exec ./entrypoint.sh`,
    )
  } else {
    // No outside access wanted: an unreachable local URL, never the default.
    args.push('-e', 'EXTERNAL_DB_URL=http://127.0.0.1:9/', image)
  }
  return args
}

export async function startUpstream({
  image,
  label,
  externalFixtureDir,
  created,
}) {
  const name = `o3dfm-parity-546-${label}-${randomBytes(3).toString('hex')}`
  let fixtureDir
  if (externalFixtureDir) {
    const runDir = createRunDir('spoolman-parity')
    runDirs.add(runDir)
    fixtureDir = join(runDir, 'fx')
    cpSync(externalFixtureDir, fixtureDir, { recursive: true })
  }
  // Listed before the create, so an interruption also removes it.
  created.push(name)
  await docker(...upstreamCreateArgs({ name, image, fixtureDir }))
  await docker('start', name)
  const logs = followLogs(name)
  const mapping = await docker('port', name, '8000/tcp')
  const port = Number(mapping.split('\n')[0].split(':').pop())
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 300_000
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (response.status === 200) break
    } catch {
      // still starting
    }
    if (Date.now() > deadline)
      throw new Error(
        `Spoolman ${name} did not become healthy:\n${logs().slice(-4000)}`,
      )
    await new Promise((done) => setTimeout(done, 500))
  }
  return {
    name,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}`,
    prefix: '',
  }
}
