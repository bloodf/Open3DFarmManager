// Exercise the README development command against a loopback-only server.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

test(
  'README npm run dev serves the farm page',
  { timeout: 300_000 },
  async () => {
    const socket = createServer()
    await new Promise((resolve, reject) =>
      socket.once('error', reject).listen(0, '127.0.0.1', resolve),
    )
    const port = socket.address().port
    await new Promise((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    )
    const child = spawn('npm', ['run', 'dev'], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    try {
      const deadline = Date.now() + 270_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw new Error(`dev exited ${child.exitCode}: ${output}`)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/farm`, {
            signal: AbortSignal.timeout(5000),
          })
          if (response.status !== 503) {
            assert.equal(response.status, 200)
            assert.match(await response.text(), /<html/i)
            return
          }
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error
        }
        await delay(1000)
      }
      assert.fail(`dev did not serve /farm: ${output}`)
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once('exit', resolve),
      )
    }
  },
)
