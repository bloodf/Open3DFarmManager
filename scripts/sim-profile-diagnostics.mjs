#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Bounded Compose diagnostics for spoolman/cams/rtsp profile failures.
// Deliberately excludes raw configs, environment and secrets.
import { isDockerSim } from '../packages/sim-tools/src/mocks/env.ts'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

if (!isDockerSim()) {
  console.log('Docker mode only (OPENFARM_SIM=docker)')
  process.exit(0)
}
const profiles = {
  spoolman: ['spoolman'],
  cams: ['camera'],
  rtsp: ['rtsp'],
}

const profile = process.argv[2]
const outPath = process.argv[3]
if (
  process.argv.length !== 4 ||
  !Object.hasOwn(profiles, profile) ||
  !outPath ||
  outPath.includes('\0') ||
  outPath.length > 512
) {
  console.error(
    'Usage: node scripts/sim-profile-diagnostics.mjs <spoolman|cams|rtsp> <output-file>',
  )
  process.exit(2)
}

const services = profiles[profile]
const compose = [
  'compose',
  '-f',
  'infra/sim/docker-compose.yml',
  '--profile',
  profile,
]

function docker(args, acceptNonzero = false) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || (!acceptNonzero && result.status !== 0)) return null
  return (result.stdout + result.stderr).slice(0, 32_768)
}

const report = {
  profile,
  services: {},
  composePs: docker([...compose, 'ps', '-a'], true) ?? 'unavailable',
}

for (const service of services) {
  const ids = docker([...compose, 'ps', '-aq', service])
  const id = ids?.trim()
  if (!id || !/^[a-f0-9]{12,64}$/.test(id)) {
    report.services[service] = { container: 'unavailable' }
    continue
  }
  const state = docker([
    'inspect',
    '--format',
    '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}',
    id,
  ])?.trim()
  const container =
    /^(created|running|paused|restarting|removing|exited|dead) \d+ (true|false)$/.test(
      state ?? '',
    )
      ? state
      : 'unavailable'
  const logs = docker(['logs', '--tail', '80', id], true)
  report.services[service] = {
    container,
    logs:
      logs === null
        ? 'unavailable'
        : logs
            .split('\n')
            .slice(-80)
            .map((line) => line.slice(0, 240))
            .join('\n')
            .slice(0, 16_384),
  }
}

const body = JSON.stringify(report).slice(0, 65_536)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, body)
console.log(`wrote ${body.length} bytes to ${outPath}`)
