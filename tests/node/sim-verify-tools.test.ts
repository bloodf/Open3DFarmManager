import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { verifyToolSwitching } from '../../packages/sim-tools/src/verify.ts'

interface FakeOptions {
  /** Ignore SAVE_VARIABLE for this tool, as a broken macro would. */
  dropSave?: number
  /** Klipper keeps the old extruder after a restart (restart never happened). */
  neverRestarts?: boolean
  /** Restart loses the saved value. */
  forgetOnRestart?: boolean
}

async function fakeMoonraker(options: FakeOptions = {}) {
  let extruder = 'extruder'
  let saved: number | undefined
  let down = 0
  const scripts: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (url.pathname === '/printer/gcode/script') {
        const script = (JSON.parse(body) as { script: string }).script
        scripts.push(script)
        const tool = Number(script.slice(1))
        extruder = tool === 0 ? 'extruder' : `extruder${tool}`
        if (tool !== options.dropSave) saved = tool
        return send(200, { result: 'ok' })
      }
      if (url.pathname === '/printer/restart') {
        scripts.push('RESTART')
        if (!options.neverRestarts) {
          extruder = 'extruder'
          down = 2
          if (options.forgetOnRestart) saved = undefined
        }
        return send(200, { result: 'ok' })
      }
      if (url.pathname === '/printer/objects/query') {
        if (down > 0) {
          down -= 1
          return send(503, { error: { message: 'Klippy Disconnected' } })
        }
        return send(200, {
          result: {
            status: {
              toolhead: { extruder },
              save_variables: {
                variables: saved === undefined ? {} : { active_tool: saved },
              },
            },
          },
        })
      }
      send(404, {})
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return { server, scripts, origin: `http://127.0.0.1:${address.port}` }
}

const close = (server: Server) => () => server.close()
const fast = { pollMs: 5, restartTimeoutMs: 500 }

test('switches T1..T3, then confirms the saved tool after a restart', async (t) => {
  const fake = await fakeMoonraker()
  t.after(close(fake.server))
  assert.equal(await verifyToolSwitching(fake.origin, fast), 3)
  assert.deepEqual(fake.scripts, ['T1', 'T2', 'T3', 'RESTART'])
})

test('fails when a tool switch is not saved', async (t) => {
  const fake = await fakeMoonraker({ dropSave: 2 })
  t.after(close(fake.server))
  await assert.rejects(
    verifyToolSwitching(fake.origin, fast),
    /T2: saved active_tool is 1, expected 2/,
  )
})

test('fails when the saved tool is lost by the restart', async (t) => {
  const fake = await fakeMoonraker({ forgetOnRestart: true })
  t.after(close(fake.server))
  await assert.rejects(
    verifyToolSwitching(fake.origin, fast),
    /after restart is undefined, expected 3/,
  )
})

test('fails when Klipper never restarts', async (t) => {
  const fake = await fakeMoonraker({ neverRestarts: true })
  t.after(close(fake.server))
  await assert.rejects(
    verifyToolSwitching(fake.origin, { pollMs: 5, restartTimeoutMs: 100 }),
    /did not restart/,
  )
})

test('refuses a non-loopback origin before sending anything', async () => {
  await assert.rejects(
    verifyToolSwitching('http://192.0.2.1:7125'),
    /loopback HTTP origin/,
  )
})
