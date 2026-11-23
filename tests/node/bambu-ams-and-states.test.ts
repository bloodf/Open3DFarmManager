import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { createBambuControlTransport } from '../../packages/connector/src/bambu/control-transport.ts'
import { buildBambuCommand } from '../../packages/connector/src/bambu/commands.ts'

test('publishes start_print AMS mapping through the validated MQTT transport', async () => {
  const remote = await startBambuSimulator({ initialState: 'IDLE' })
  const directory = mkdtempSync(join(tmpdir(), 'bambu-ams-state-'))
  const credentialFile = join(directory, 'credentials')
  writeFileSync(credentialFile, JSON.stringify({ accessCode: 'secret' }), {
    mode: 0o600,
  })
  const controller = new AbortController()
  let connectedResolve!: () => void
  const connected = new Promise<void>((resolve) => (connectedResolve = resolve))
  const transport = createBambuControlTransport({
    host: remote.host,
    port: remote.port,
    serial: 'SYNTHETIC',
    credentials: { username: 'bblp', password: 'secret' },
    caPem: remote.syntheticTrust,
    limits: {
      maxFrameBytes: 131072,
      connectTimeoutMs: 1000,
      maxInflight: 16,
      reconnectDelayMs: 100,
      maxReconnects: 0,
    },
    signal: controller.signal,
    onReport: () => {},
    onConnection: (state) => {
      if (state === 'connected') connectedResolve()
    },
  })
  try {
    await connected
    const request = buildBambuCommand('start_print', {
      file: 'test.3mf',
      ams_mapping: [0, 2],
    })
    await transport.publish(request, () => true)
    for (let i = 0; i < 100 && remote.requests.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(remote.requests[0], {
      command: 'project_file',
      sequence_id: '0',
      ams_mapping: [0, 2],
      use_ams: true,
    })
  } finally {
    controller.abort()
    await transport.done
    await remote.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
