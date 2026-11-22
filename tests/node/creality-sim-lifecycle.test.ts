import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

const require = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)
const WebSocket = require('ws')

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate(), `timed out waiting for ${description}`)
}

test('upload and start produce progress and completion, cancellation and failure', async () => {
  for (const outcome of ['complete', 'cancel', 'fail']) {
    const sim = await createCrealitySimulator(
      { state: 0 },
      { durationMs: 200, totalLayers: 4, fail: outcome === 'fail' },
    )
    const ws = new WebSocket(`ws://127.0.0.1:${sim.port}`)
    const frames: any[] = []
    ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString())))
    try {
      await new Promise<void>((resolve) => ws.once('open', resolve))
      ws.send(
        JSON.stringify({
          method: 'upload',
          params: { filename: 'part.gcode' },
        }),
      )
      ws.send(JSON.stringify({ method: 'start', params: {} }))
      await waitFor(
        () =>
          Number(sim.state.printProgress) > 0 && Number(sim.state.layer) > 0,
        'simulator print progress',
      )
      assert.equal(sim.state.state, 1)
      if (outcome === 'cancel')
        ws.send(JSON.stringify({ method: 'set', params: { stop: 1 } }))
      await waitFor(
        () => sim.state.state === 0,
        'print completion or cancellation',
      )
      assert.equal(sim.state.state, 0)
      if (outcome === 'cancel') assert.ok(Number(sim.state.printProgress) < 100)
      else {
        assert.equal(sim.state.printProgress, 100)
        assert.equal(sim.state.layer, 4)
        assert.equal(sim.state.err, outcome === 'fail' ? 1 : 0)
      }
      assert.ok(frames.some((frame) => frame.state === 1))
    } finally {
      ws.terminate()
      await sim.close()
    }
  }
})
