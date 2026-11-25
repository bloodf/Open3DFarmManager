import { describe, expect, it } from 'vitest'
import { createPhrozenCollection } from '../../packages/connector/src/phrozen/collection.ts'
import { parsePhrozenBinding } from '../../packages/connector/src/phrozen/config.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import fixture from '../fixtures/phrozen/synthetic-revo-14k-v153.json'

const binding = {
  family: 'phrozen',
  printerKey: 'revo',
  origin: 'ws://127.0.0.1:3030',
  discoveryPort: 3000,
  simulated: true,
  expect: {
    id: fixture.Id,
    board: fixture.Data.MainboardID,
    model: 'Sonic Mighty Revo 14K',
    firmware: 'V153',
  },
} as const

describe('Phrozen collection', () => {
  it('requires an explicit canonical local origin and rejects credential fields', () => {
    expect(parsePhrozenBinding(binding, [binding.origin])).toEqual(binding)
    expect(() => parsePhrozenBinding(binding, [])).toThrow('not allowlisted')
    for (const origin of [
      'ws://192.0.2.10:3030',
      'ws://localhost:3030',
      'ws://127.1:3030',
      'ws://user:pass@127.0.0.1:3030',
      'ws://127.0.0.1:3030/websocket',
    ])
      expect(() =>
        parsePhrozenBinding({ ...binding, origin }, [origin]),
      ).toThrow()
    expect(() =>
      parsePhrozenBinding({ ...binding, apiKey: 'fixture' }, [binding.origin]),
    ).toThrow()
    for (const model of [
      'Sonic Mighty Revo',
      'Sonic Mighty Revo 16K',
      'Sonic Mighty Revo 16K MAX',
    ])
      expect(() =>
        parsePhrozenBinding(
          { ...binding, expect: { ...binding.expect, model } },
          [binding.origin],
        ),
      ).toThrow()
  })

  it.each(['identity', 'denied', 'timeout'] as const)(
    'withdraws on %s and recovers with a distinct epoch using only status calls',
    async (fault) => {
      const device = structuredClone(fixture)
      const simulator = await startPhrozenSimulator(device)
      const controller = new AbortController()
      const origin = `ws://127.0.0.1:${simulator.wsPort}`
      const events: unknown[] = []
      const simulated = fault !== 'denied'
      const collection = createPhrozenCollection({
        binding: {
          ...binding,
          origin,
          discoveryPort: simulator.udpPort,
          simulated,
        },
        allowedOrigins: [origin],
        signal: controller.signal,
        timeoutMs: 250,
        pollMs: 10,
        onObservation({ epoch, printer }) {
          events.push({
            epoch,
            state: printer.state,
            reason: printer.statusReason,
            controls: printer.controls,
          })
          if (epoch === 2) controller.abort()
          else if (fault === 'identity') device.Data.MainboardID = 'ffff'
          else simulator.setFault(fault)
        },
        onUnavailable(epoch) {
          events.push({ withdrawn: epoch, calls: simulator.commands.length })
          device.Data.MainboardID = fixture.Data.MainboardID
          simulator.setFault()
        },
      })
      const deadline = setTimeout(() => controller.abort(), 3000)
      try {
        await collection.done
        const reason = simulated ? 'phrozen-simulated' : 'phrozen-unqualified'
        expect(events).toEqual([
          { epoch: 1, state: 'printing', reason, controls: [] },
          { withdrawn: 1, calls: fault === 'identity' ? 1 : 2 },
          { epoch: 2, state: 'printing', reason, controls: [] },
        ])
        expect(simulator.commands).toEqual(
          fault === 'identity' ? [0, 0] : [0, 0, 0],
        )
      } finally {
        clearTimeout(deadline)
        controller.abort()
        await simulator.close()
      }
    },
  )
})
