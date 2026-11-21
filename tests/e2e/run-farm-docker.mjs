import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidence = mkdtempSync(join(tmpdir(), 'openfarm-farm-evidence-'))
const id = `farm-evidence-${randomUUID()}`
const network = `${id}-network`
const container = `${id}-app`
const proxy = `${id}-proxy`
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options })
let networkCreated = false
let containerCreated = false
let proxyCreated = false
const generated = [
  'node_modules',
  'apps/farm/node_modules',
  'apps/farm/.nuxt',
  'apps/farm/.output',
]
  .map((path) => join(root, path))
  .filter((path) => !existsSync(path))
try {
  console.log(`Evidence: ${evidence}`)
  if (!existsSync(join(root, 'node_modules/.bin/playwright')))
    run('npm', ['ci', '--offline', '--ignore-scripts'])
  run('npm', ['run', 'build', '-w', '@open3dfarmmanager/farm'], {
    env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' },
  })
  run('docker', ['network', 'create', '--internal', network])
  networkCreated = true
  run('docker', [
    'create',
    '--pull=never',
    '--name',
    container,
    '--network',
    network,
    '-v',
    `${join(root, 'apps/farm/.output')}:/app:ro`,
    '-w',
    '/app',
    '-e',
    'NITRO_HOST=0.0.0.0',
    '-e',
    'NITRO_PORT=3000',
    'node:24-alpine',
    'node',
    'server/index.mjs',
  ])
  containerCreated = true
  run('docker', ['start', container])
  run('docker', [
    'create',
    '--pull=never',
    '--name',
    proxy,
    '-p',
    '127.0.0.1::3000',
    'node:24-alpine',
    'node',
    '-e',
    `const net = require('node:net'); net.createServer(s => { const upstream = net.connect(3000, '${container}'); s.pipe(upstream).pipe(s); upstream.on('error', () => s.destroy()); s.on('error', () => upstream.destroy()) }).listen(3000, '0.0.0.0')`,
  ])
  proxyCreated = true
  run('docker', ['network', 'connect', network, proxy])
  run('docker', ['start', proxy])
  let port = 0
  for (let attempt = 0; attempt < 30 && !port; attempt++) {
    const result = spawnSync('docker', ['port', proxy, '3000/tcp'], {
      encoding: 'utf8',
    })
    port = Number(result.stdout.trim().split(':').pop()) || 0
    if (!port) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!port) {
    run('docker', ['logs', container])
    throw new Error('Docker did not publish the application port')
  }
  const url = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) {
        ready = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!ready) throw new Error('Docker application did not become healthy')
  const config = join(evidence, 'playwright.config.mjs')
  writeFileSync(
    config,
    `export default ${JSON.stringify({ testDir: join(root, 'tests/e2e'), timeout: 30000, workers: 1, use: { baseURL: url, channel: 'chrome', headless: true }, outputDir: join(evidence, 'results') })}\n`,
  )
  for (const phase of ['before', 'after']) {
    const shots = join(evidence, phase)
    mkdirSync(shots)
    const args = ['test', '-c', config, 'polish-farm.spec.ts']
    if (phase === 'before')
      args.push('--grep', 'screenshots of real screen states')
    const result = spawnSync(join(root, 'node_modules/.bin/playwright'), args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, POLISH_FARM_SHOTS_DIR: shots },
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`Playwright ${phase} failed: ${result.status}`)
  }
} finally {
  if (proxyCreated) run('docker', ['rm', '-f', proxy])
  if (containerCreated) run('docker', ['rm', '-f', container])
  if (networkCreated) run('docker', ['network', 'rm', network])
  for (const path of generated) rmSync(path, { recursive: true, force: true })
}
