// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { accessSync, constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const imageTag =
  process.env.OPEN3D_CHECK_IMAGE_TAG?.trim() || 'open3dfarmmanager/check:node22'
const inner = process.env.OPEN3D_DOCKER_CHECK_INNER === '1'
const skipBuild = process.env.OPEN3D_CHECK_IMAGE_SKIP_BUILD === '1'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${detail}`,
    )
  }
  return result
}

async function assertChromeLoadsLoopbackPage() {
  accessSync('/opt/google/chrome/chrome', constants.X_OK)
  const { browserOptions, withBrowser } =
    await import('../tests/helpers/browser.ts')
  assert.match(process.version, /^v22\./)
  assert.equal(browserOptions().channel, 'chrome')

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Docker check</title>')
  })
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await withBrowser({}, async (browser) => {
      const page = await browser.newPage()
      const response = await page.goto(`http://127.0.0.1:${address.port}/`)
      assert.equal(response.status(), 200)
      assert.equal(await page.title(), 'Docker check')
    })
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

if (inner) {
  test(
    'Node 22 and the Chrome channel can load a loopback page',
    { timeout: 300_000 },
    assertChromeLoadsLoopbackPage,
  )
} else {
  test(
    'Docker check image provides Node 22 and Chrome for a loopback page',
    { timeout: 10_800_000 },
    () => {
      if (!skipBuild) {
        run(
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
      }

      const containerName = `o3dfm-node22-smoke-${process.pid}`
      try {
        // One container: Node version, Chrome binary, and Playwright channel.
        run(
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
            '--env',
            'OPEN3D_DOCKER_CHECK_INNER=1',
            imageTag,
            'node',
            '--test',
            'scripts/test-docker-check-image.mjs',
          ],
          { cwd: root, stdio: 'inherit' },
        )
      } finally {
        spawnSync('docker', ['rm', '--force', containerName], {
          encoding: 'utf8',
        })
      }
    },
  )
}
