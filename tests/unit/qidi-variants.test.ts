// spec-derived, not captured: simulator values on object names from the pinned
// Qidi sources in docs/fullfarmmanager/evidence/qidi.md.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { QIDI_MODELS } from '../../packages/connector/src/qidi/profiles.ts'
import { qidiReadings } from '../../packages/connector/src/qidi/readings.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  CompleteFarmSnapshot,
  FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import {
  createQidiCollection,
  type QidiObservation,
} from '../../packages/connector/src/runtime/qidi-collection.ts'
import { startQidiSimulator } from '../../packages/sim-tools/src/qidi-simulator.ts'
import fixture from '../fixtures/qidi/moonraker.json'
import { qidiVariant, qidiVariants } from '../fixtures/qidi/variants.ts'

test('every provisionable model has a variant fixture', () => {
  expect(qidiVariants.map((variant) => variant.model)).toEqual([...QIDI_MODELS])
})

async function observe(
  model: string | undefined,
  objects: Record<string, unknown>,
) {
  const state = structuredClone(fixture.state)
  Object.assign(state.result.status, objects)
  const simulator = await startQidiSimulator({
    ...fixture,
    state,
    snapshot: new Uint8Array(),
  })
  const directory = await mkdtemp(join(tmpdir(), 'qidi-variant-'))
  const controller = new AbortController()
  let done: Promise<void> | undefined
  try {
    const { origin } = simulator
    const credentialFile = join(directory, 'qidi-fixture-credential.json')
    await writeFile(
      credentialFile,
      JSON.stringify({ origin, secret: 'fixture-key' }),
      { mode: 0o600 },
    )
    const observations: QidiObservation[] = []
    done = createQidiCollection({
      binding: {
        family: 'qidi',
        printerKey: 'sim-qidi',
        origin,
        simulated: true,
        expect: { ...(model ? { model } : {}), moonrakerVersion: 'v0.8.0' },
        auth: { kind: 'api-key', credentialFile },
      },
      allowedOrigins: [origin],
      signal: controller.signal,
      timeoutMs: 1000,
      onObservation: (value) => observations.push(value),
      onUnavailable: () => {},
    }).done
    await vi.waitFor(() => expect(observations).not.toHaveLength(0), {
      timeout: 5000,
    })
    return { observation: observations[0]!, requests: [...simulator.requests] }
  } finally {
    controller.abort()
    await done
    await simulator.close()
    await rm(directory, { recursive: true, force: true })
  }
}

/** The frame the browser receives, with controls offered by the caller. */
async function liveFrame(observation: QidiObservation) {
  const agentId = randomUUID()
  const refs = [{ assignmentId: randomUUID(), agentId, printerKey: 'sim-qidi' }]
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    controlsFor: () => ['pause'],
  })
  const controller = new AbortController()
  try {
    source.observe(observation)
    const received: CompleteFarmSnapshot[] = []
    source.open({
      binding: {
        agent_id: agentId,
      } as Parameters<FarmSnapshotProvider>[0]['binding'],
      deadlineMonoMs: performance.now() + 60_000,
      assignmentRefs: refs,
      signal: controller.signal,
      onComplete: (value) => void received.push(value),
      onUnavailable: () => {},
    })
    await vi.waitFor(() => expect(received).not.toHaveLength(0))
    return received[0]!.printers[0]!
  } finally {
    controller.abort()
    source.close()
  }
}

test.each(qidiVariants)(
  '$model reads only its cited objects into the read-only frame',
  async (variant) => {
    const { observation, requests } = await observe(
      variant.model,
      variant.objects,
    )
    expect(new Set(requests)).toEqual(
      new Set(['GET /server/info', `GET ${variant.query}`]),
    )
    const printer = await liveFrame(observation)
    expect(printer.fans).toEqual(variant.fans)
    expect(printer.chamberTemperatureCelsius).toBe(variant.chamber?.temperature)
    expect(printer.chamberTargetCelsius).toBe(variant.chamber?.target)
    expect(printer.materials).toEqual(variant.materials)
    expect(printer.identity).toEqual({ vendor: 'Qidi' })
    expect(printer.controls).toEqual([])
  },
)

test('a binding without a model reports no variant fields', async () => {
  const { observation, requests } = await observe(
    undefined,
    qidiVariant('Max4').objects,
  )
  expect(requests).toContain(
    'GET /printer/objects/query?webhooks&print_stats&virtual_sdcard&extruder&heater_bed&fan&fan_generic%20cooling_fan',
  )
  const printer = await liveFrame(observation)
  for (const field of [
    'fans',
    'materials',
    'chamberTemperatureCelsius',
    'chamberTargetCelsius',
  ] as const)
    expect(printer[field]).toBeUndefined()
})

test('missing and malformed optional readings keep the print status', async () => {
  const { observation } = await observe('Q2', {
    'fan_generic cooling_fan': { speed: 1.5 },
    'fan_generic auxiliary_cooling_fan': { speed: '0.5' },
    'heater_generic chamber': { temperature: null },
  })
  const printer = await liveFrame(observation)
  expect(printer.state).toBe('printing')
  expect(printer.progress).toBe(0.25)
  expect(printer.fans).toBeUndefined()
  expect(printer.chamberTemperatureCelsius).toBeUndefined()
  expect(printer.chamberTargetCelsius).toBeUndefined()
})

test('Max4 reports one auxiliary reading only when both fans agree', () => {
  const fan = { speed: 0.4 }
  expect(qidiReadings('Max4', { auxFans: [fan, fan] }).fans).toEqual({
    aux: 40,
  })
  for (const other of [{ speed: 0.8 }, undefined, {}]) {
    expect(qidiReadings('Max4', { auxFans: [fan, other] })).toEqual({})
    expect(qidiReadings('Max4', { auxFans: [other, fan] })).toEqual({})
  }
})

test('Max4 Box slots need a reported Box count and an inserted flag', () => {
  const slot = {
    box0_box_inserted_2: 1,
    box0_filament_info_2_filament_type: '  ',
    box0_filament_info_2_color_rgb_str: ['blue'],
  }
  expect(qidiReadings('Max4', { box: { box_count: 1, ...slot } })).toEqual({
    materials: [{ slot: 'QIDI Box 1, slot 3' }],
  })
  for (const box of [
    undefined,
    slot,
    { box_count: 0, ...slot },
    { box_count: 5, ...slot },
    { box_count: '1', ...slot },
    { box_count: 1 },
    { box_count: 1, ...slot, box0_box_inserted_2: '1' },
  ])
    expect(qidiReadings('Max4', { box })).toEqual({})
})

test('four full Boxes fit the farm material limit', () => {
  const box: Record<string, unknown> = { box_count: 4 }
  for (let unit = 0; unit < 4; unit++)
    for (let slot = 0; slot < 4; slot++)
      box[`box${unit}_box_inserted_${slot}`] = 1
  const { materials } = qidiReadings('Max4', { box })
  expect(materials).toHaveLength(16)
  expect(materials?.at(-1)?.slot).toBe('QIDI Box 4, slot 4')
  expect(materials?.every((entry) => entry.slot.length <= 32)).toBe(true)
})

test.each(QIDI_MODELS.filter((model) => model !== 'Max4'))(
  '%s ignores Box data it has no cited object for',
  (model) => {
    expect(
      qidiReadings(model, {
        box: { box_count: 1, box0_box_inserted_0: 1 },
      }),
    ).toEqual({})
  },
)
