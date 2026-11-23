import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { parseQidiBinding } from '../../packages/connector/src/qidi/config.ts'
import {
  createQidiCollection,
  type QidiObservation,
} from '../../packages/connector/src/runtime/qidi-collection.ts'
import { startQidiSimulator } from '../../packages/sim-tools/src/qidi-simulator.ts'
import fixture from '../fixtures/qidi/moonraker.json'

test('collects, withdraws failed sources, and recovers in new read-only epochs', async () => {
  const info = structuredClone(fixture.info)
  const state = structuredClone(fixture.state)
  const simulator = await startQidiSimulator({
    ...fixture,
    info,
    state,
    snapshot: new Uint8Array(),
  })
  const directory = await mkdtemp(join(tmpdir(), 'qidi-collection-'))
  const controller = new AbortController()
  let done: Promise<void> | undefined
  try {
    const { origin } = simulator
    const credentialFile = join(directory, 'qidi-fixture-credential.json')
    const writeCredential = (secret: string) =>
      writeFile(credentialFile, JSON.stringify({ origin, secret }), {
        mode: 0o600,
      })
    await writeCredential('fixture-key')
    const binding = {
      family: 'qidi',
      printerKey: 'sim-qidi',
      origin,
      simulated: true,
      expect: {
        model: 'Q1 Pro',
        firmware: '4.4.24',
        moonrakerVersion: 'v0.8.0',
      },
      auth: { kind: 'api-key', credentialFile },
    }
    const observations: QidiObservation[] = []
    const withdrawn: number[] = []
    const wait = (assertion: () => void) =>
      vi.waitFor(assertion, { timeout: 5500 })
    done = createQidiCollection({
      binding,
      allowedOrigins: [origin],
      signal: controller.signal,
      timeoutMs: 500,
      onObservation: (value) => observations.push(value),
      onUnavailable: (epoch) => withdrawn.push(epoch),
    }).done
    await wait(() =>
      expect(observations.at(-1)).toMatchObject({
        epoch: 1,
        printer: {
          state: 'printing',
          progress: 0.25,
          statusReason: 'qidi-simulated',
          identity: { vendor: 'Qidi' },
        },
      }),
    )

    expect(observations[0]?.printer.identity).toEqual({ vendor: 'Qidi' })
    info.result.moonraker_version = 'wrong-version'
    await wait(() => expect(withdrawn).toEqual([1]))
    expect(observations).toHaveLength(1)

    info.result.moonraker_version = 'v0.8.0'
    await writeCredential('wrong-key')
    await wait(() => expect(simulator.requests).toHaveLength(4))
    expect(withdrawn).toEqual([1])
    expect(observations).toHaveLength(1)

    await writeCredential('fixture-key')
    state.result.status.print_stats.state = 'paused'
    await wait(() =>
      expect(observations.at(-1)).toMatchObject({
        epoch: 2,
        printer: { state: 'paused' },
      }),
    )

    simulator.setFault('timeout')
    await wait(() => expect(withdrawn).toEqual([1, 2]))
    simulator.setFault(undefined)
    state.result.status.print_stats.state = 'complete'
    await wait(() =>
      expect(observations.at(-1)).toMatchObject({
        epoch: 3,
        printer: { state: 'idle' },
      }),
    )
    expect(simulator.uploads).toEqual([])
    expect(
      simulator.requests.every(
        (request) =>
          request === 'GET /server/info' ||
          request ===
            'GET /printer/objects/query?webhooks&print_stats&virtual_sdcard&extruder&heater_bed&fan',
      ),
    ).toBe(true)
  } finally {
    controller.abort()
    await done
    await simulator.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test('requires an explicitly allowed canonical local IP origin', () => {
  const origin = 'http://127.0.0.1:7125'
  const binding = {
    family: 'qidi',
    printerKey: 'qidi',
    origin,
    simulated: false,
    expect: { model: 'Q2', firmware: '1.1.1', moonrakerVersion: 'v0.8.0' },
    auth: { kind: 'trusted-lan' },
  }
  expect(parseQidiBinding(binding, [origin]).origin).toBe(origin)
  expect(
    parseQidiBinding({ ...binding, expect: { moonrakerVersion: 'v0.8.0' } }, [
      origin,
    ]).expect,
  ).toEqual({ moonrakerVersion: 'v0.8.0' })
  expect(() => parseQidiBinding(binding, [])).toThrow('not allowlisted')
  for (const target of [
    'http://8.8.8.8',
    'http://qidi.local',
    origin + '/',
    'http://user@127.0.0.1:7125',
  ]) {
    expect(() =>
      parseQidiBinding({ ...binding, origin: target }, [target]),
    ).toThrow()
  }
  expect(() =>
    parseQidiBinding(
      { ...binding, expect: { ...binding.expect, model: 'unknown' } },
      [origin],
    ),
  ).toThrow()
})
