import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const builtEntry = join(root, 'apps/farm/.output/server/index.mjs')
const host = process.env.NITRO_HOST ?? '127.0.0.1'
const port = Number(process.env.NITRO_PORT ?? '3100')

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('NITRO_PORT must be a valid loopback port')
  process.exit(1)
}

let built = true
try {
  await access(builtEntry)
} catch {
  built = false
}

if (!built) {
  const build = spawn(
    process.execPath,
    [
      join(root, 'node_modules/nuxt/bin/nuxt.mjs'),
      'build',
      join(root, 'apps/farm'),
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  )
  const code = await new Promise((resolve, reject) => {
    build.once('error', reject)
    build.once('exit', (status) => resolve(status))
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => build.kill(signal))
    }
  })
  if (code !== 0) process.exit(code ?? 1)
}

const child = spawn(process.execPath, [builtEntry], {
  env: { ...process.env, NITRO_HOST: host, NITRO_PORT: String(port) },
  stdio: 'inherit',
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
const forward = (signal) => {
  if (!child.killed) child.kill(signal)
}
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))
