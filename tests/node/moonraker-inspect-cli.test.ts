import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type * as Ws from '../../packages/connector/node_modules/@types/ws/index.d.ts'
const { WebSocketServer } = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('ws') as typeof Ws

function run(args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [
        'scripts/inspect-moonraker.ts',
        ...args,
      ])
      let out = '',
        err = ''
      child.stdout.on('data', (data) => {
        out += data
      })
      child.stderr.on('data', (data) => {
        err += data
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, out, err }))
    },
  )
}

test('help and invalid arguments use standard exit codes', async () => {
  assert.equal((await run(['--help'])).code, 0)
  assert.equal((await run([])).code, 2)
})

test('inspects only the selected synthetic peer with local authentication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moonraker-inspect-'))
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const keyFile = join(dir, 'key.json')
    const configFile = join(dir, 'config.json')
    await writeFile(
      keyFile,
      JSON.stringify({ origin, apiKey: 'synthetic_key' }),
      { mode: 0o600 },
    )
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        allowedOrigins: [origin],
        printers: [{ printerKey: 'test', origin, apiKeyFile: keyFile }],
      }),
      { mode: 0o600 },
    )
    const methods: string[] = []
    server.on('connection', (socket, request) => {
      assert.equal(request.headers['x-api-key'], 'synthetic_key')
      socket.on('message', (data) => {
        const rpc = JSON.parse(data.toString())
        methods.push(rpc.method)
        const result =
          rpc.method === 'server.connection.identify'
            ? { connection_id: 1 }
            : rpc.method === 'server.info'
              ? {
                  klippy_connected: true,
                  klippy_state: 'ready',
                  moonraker_version: 'v1',
                }
              : rpc.method === 'printer.objects.list'
                ? { objects: ['extruder'] }
                : rpc.method === 'printer.objects.query'
                  ? {
                      status: {
                        toolhead: { extruder: 'extruder' },
                        extruder: { temperature: 22, target: 0 },
                      },
                    }
                  : { webcams: [] }
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      })
    })
    const result = await run(['--config', configFile, '--printer', 'test'])
    assert.equal(result.code, 0, result.err)
    assert.deepEqual(JSON.parse(result.out), {
      model: null,
      firmware: null,
      moonrakerVersion: 'v1',
      readiness: 'ready',
      tools: [
        {
          index: 0,
          object: 'extruder',
          active: true,
          celsius: 22,
          targetCelsius: 0,
        },
      ],
    })
    assert.deepEqual(methods, [
      'server.connection.identify',
      'server.info',
      'printer.objects.list',
      'printer.objects.query',
      'server.webcams.list',
    ])
    assert.equal(
      (await run(['--config', configFile, '--printer', 'missing'])).code,
      2,
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(dir, { recursive: true, force: true })
  }
})
