import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import {
  createFlashforgeCollection,
  type FlashforgeObservation,
} from '../../packages/connector/src/flashforge/collection.ts'
import { FlashforgeBindingSchema } from '../../packages/connector/src/flashforge/config.ts'
import { startFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import fixture from '../fixtures/flashforge/detail.json'

test('collects authenticated status, withdraws a failed epoch and recovers without writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flashforge-collection-'))
  const signal = new AbortController()
  const requests: string[] = []
  const observations: FlashforgeObservation[] = []
  const withdrawn: number[] = []
  let reply = fixture
  let checkCode = 'FIXTURE-CODE'
  const simulator = await startFlashforgeSimulator((req, res, body) => {
    requests.push(`${req.method} ${req.url}`)
    const credential = JSON.parse(body.toString())
    res.end(
      JSON.stringify(
        credential.serialNumber === 'FIXTURE-SERIAL' &&
          credential.checkCode === checkCode
          ? reply
          : { code: 1 },
      ),
    )
  })
  let collection: ReturnType<typeof createFlashforgeCollection> | undefined
  try {
    const origin = `http://${simulator.host}:${simulator.port}`
    const credentialFile = join(directory, 'credential.json')
    const binding = FlashforgeBindingSchema.parse({
      family: 'flashforge',
      origin,
      credentialFile,
      printerKey: 'fixture',
      expect: { serialNumber: 'FIXTURE-SERIAL', model: 'Adventurer 5M Pro' },
      simulated: true,
    })
    const writeCredential = (endpoint: string) =>
      writeFileSync(
        credentialFile,
        JSON.stringify({
          origin: endpoint,
          serialNumber: 'FIXTURE-SERIAL',
          checkCode,
        }),
        { mode: 0o600 },
      )
    const input = {
      binding,
      allowedOrigins: [origin],
      signal: signal.signal,
      timeoutMs: 1000,
      onObservation: (value: FlashforgeObservation) => observations.push(value),
      onUnavailable: (epoch: number) => withdrawn.push(epoch),
    }

    for (const invalidOrigin of [
      'http://8.8.8.8:8898',
      origin + '/detail',
      'http://localhost:8898',
    ]) {
      expect(
        FlashforgeBindingSchema.safeParse({ ...binding, origin: invalidOrigin })
          .success,
      ).toBe(false)
    }
    expect(() =>
      createFlashforgeCollection({ ...input, allowedOrigins: [] }),
    ).toThrow('not allowlisted')
    writeCredential('http://127.0.0.1:8898')
    expect(() => createFlashforgeCollection(input)).toThrow(
      'Invalid private Flashforge credential',
    )
    expect(requests).toEqual([])

    writeCredential(origin)
    collection = createFlashforgeCollection(input)
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0]).toMatchObject({
      epoch: 1,
      printer: {
        state: 'printing',
        progress: 0.25,
        statusReason: 'flashforge-simulated',
        identity: { vendor: 'Flashforge', model: 'Adventurer 5M Pro' },
      },
    })

    reply = { ...fixture, detail: { ...fixture.detail, pid: '0023' } }
    await vi.waitFor(() => expect(withdrawn).toEqual([1]), { timeout: 3500 })
    expect(observations).toHaveLength(1)

    checkCode = 'CHANGED'
    reply = fixture
    await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 3500 })
    expect(withdrawn).toEqual([1])
    expect(observations).toHaveLength(1)

    checkCode = 'FIXTURE-CODE'
    reply = {
      ...fixture,
      detail: { ...fixture.detail, status: 'pause', printProgress: 0.5 },
    }
    await vi.waitFor(() => expect(observations).toHaveLength(2), {
      timeout: 3500,
    })
    expect(withdrawn).toEqual([1])
    expect(observations[1]).toMatchObject({
      epoch: 2,
      printer: { state: 'paused', progress: 0.5 },
    })
    expect(requests).toEqual(Array(4).fill('POST /detail'))
  } finally {
    signal.abort()
    try {
      await collection?.done
    } finally {
      await simulator.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
