// The pinned real Spoolman: one task-owned container per corpus, published
// on a loopback port only. The optional external-library fixture is served by a
// python http.server inside the same container (no host port, no network
// access to the outside is used: EXTERNAL_DB_URL points at 127.0.0.1).
import { randomBytes } from 'node:crypto'
import { docker, OWNER_LABEL, TASK } from './docker.mjs'

const FIXTURE_PORT = 8099

export async function startUpstream({
  image,
  label,
  externalFixtureDir,
  created,
}) {
  const name = `o3dfm-parity-546-${label}-${randomBytes(3).toString('hex')}`
  const args = [
    'create',
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
    '-e',
    'SPOOLMAN_DEBUG_MODE=FALSE',
  ]
  if (externalFixtureDir) {
    args.push(
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
  await docker(...args)
  created.push(name)
  if (externalFixtureDir)
    await docker('cp', `${externalFixtureDir}/.`, `${name}:/fx`)
  await docker('start', name)
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
    if (Date.now() > deadline) {
      const logs = await docker('logs', '--tail', '30', name).catch(() => '')
      throw new Error(`Spoolman ${name} did not become healthy:\n${logs}`)
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  return { name, baseUrl, wsUrl: `ws://127.0.0.1:${port}`, prefix: '' }
}
