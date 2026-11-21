// SPDX-License-Identifier: MIT
/**
 * Builds the Docker check image and runs the environment-sensitive Node suites
 * that previously failed only inside the image (root permissions, old git,
 * missing Python, missing .env.example). Uses the same docker run flags as the
 * full offline check (`--network none --shm-size 1g`).
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const imageTag =
  process.env.OPEN3D_CHECK_IMAGE_TAG?.trim() || 'open3dfarmmanager/check:node22'
const skipBuild = process.env.OPEN3D_CHECK_IMAGE_SKIP_BUILD === '1'

const SUITES = [
  'tests/node/connector-credential-renewal.test.ts',
  'tests/node/self-host-guide.test.ts',
  'tests/node/simulator-identify-diagnostic.test.ts',
  'tests/unit/pause-authority-tooling.test.ts',
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function fail(message, result) {
  const detail = [result?.stdout, result?.stderr].filter(Boolean).join('\n')
  console.error(detail ? `${message}\n${detail}` : message)
  process.exit(result?.status && result.status !== 0 ? result.status : 1)
}

if (!skipBuild) {
  const build = run(
    'docker',
    [
      'build',
      '--platform',
      'linux/amd64',
      '--file',
      'infra/check/Dockerfile',
      '--tag',
      imageTag,
      '.',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  if (build.status !== 0) {
    fail(`docker build failed (${build.status})`, build)
  }
}

const containerName = `o3dfm-check-env-${process.pid}`
let status = 1
try {
  const result = run(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      'none',
      '--shm-size',
      '1g',
      imageTag,
      'node',
      '--test',
      '--test-concurrency=1',
      '--test-timeout=120000',
      '--test-force-exit',
      ...SUITES,
    ],
    { cwd: root, stdio: 'inherit' },
  )
  status = result.status ?? 1
  if (status !== 0) {
    fail(`environment-sensitive suites failed (${status})`, result)
  }
} finally {
  spawnSync('docker', ['rm', '--force', containerName], { encoding: 'utf8' })
}

process.exit(status)
