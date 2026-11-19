import { randomUUID } from 'node:crypto'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { expect, it } from 'vitest'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  excludeObjectProbe,
  excludeObjectWire,
} from '../../packages/connector/src/moonraker/control-print-status.ts'
import { moonrakerControls } from '../../packages/connector/src/moonraker/control-support.ts'
import {
  ControlArguments,
  controlRoleAllowed,
  controlSourceState,
} from '../../packages/farm-protocol/src/control-actions.ts'

it.each([
  ['standby', 'fixture', 'Object exclusion requires an active print'],
  ['printing', 'unknown', 'Unknown print object'],
  ['printing', 'fixture', null],
  ['paused', 'fixture', null],
] as const)('handles %s with object %s', async (state, name, refusal) => {
  const mock = await startMoonrakerMock({ initial: { state } })
  const socket = new WebSocket(
    mock.origin.replace('http:', 'ws:') + '/websocket',
  )
  const request = (wire: string) =>
    new Promise<unknown>((resolve, reject) => {
      socket.addEventListener(
        'message',
        ({ data }) => {
          const reply = JSON.parse(data)
          if (reply.error) reject(new Error(reply.error.message))
          else resolve(reply.result)
        },
        { once: true },
      )
      socket.send(wire)
    })
  const script = (script: string) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'printer.gcode.script',
      params: { script },
    })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    await request(script('EXCLUDE_OBJECT_DEFINE NAME=fixture'))
    const guard = new AbortController()
    const allowedOrigins = [mock.origin]
    const binding = createPrinterBindingRegistry({ allowedOrigins }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'fixture',
      moonraker_origin: mock.origin,
    })
    let mono = performance.now()
    const attempt = openFixedMoonrakerPause({
      binding,
      allowedOrigins,
      limits: {
        maxMessageBytes: 4096,
        connectTimeoutMs: 2000,
        requestTimeoutMs: 2000,
        staleAfterMs: 2000,
        reconnectMinMs: 100,
        reconnectMaxMs: 100,
      },
      connectionGeneration: 1,
      signal: guard.signal,
      publish() {},
      clock: {
        monotonicNow: () => (mono = Math.max(performance.now(), mono + 0.001)),
      },
      objects: ['print_stats', 'exclude_object'],
    })
    try {
      await attempt.prepare()
      let sentMono = 0
      const beforeSend = () => {
        sentMono = mono
        return true
      }
      const command = attempt.driver.execute!(
        'exclude_object',
        { name },
        {
          binding,
          beforeSend,
          signal: guard.signal,
        },
      )
      if (refusal) {
        await expect(command).rejects.toMatchObject({
          refusal: 'state',
          message: refusal,
        })
        expect(sentMono).toBe(0)
        expect(mock.control.gcodeScripts).toEqual([
          'EXCLUDE_OBJECT_DEFINE NAME=fixture',
        ])
      } else {
        await expect(command).resolves.toEqual({ acknowledged: true })
        expect(
          await attempt.driver.waitForPaused({
            binding,
            signal: guard.signal,
            after: { connectionGeneration: 1, sequence: 1, sentMono },
          }),
        ).toMatchObject({ effect: { kind: 'excluded-object', name } })
        expect(mock.control.gcodeScripts).toEqual([
          'EXCLUDE_OBJECT_DEFINE NAME=fixture',
          'EXCLUDE_OBJECT NAME=fixture',
        ])
        const updated = await request(excludeObjectProbe(11))
        expect(() => excludeObjectWire({ name }, updated)).toThrow(
          'Print object unavailable',
        )
      }
    } finally {
      await attempt.close()
    }
  } finally {
    socket.close()
    await mock.close()
  }
})

it('requires a supported printer, operator authority, active print and safe name', () => {
  expect(moonrakerControls(['print_stats'])).not.toContain('exclude_object')
  expect(moonrakerControls(['print_stats', 'exclude_object'])).toContain(
    'exclude_object',
  )
  expect(controlRoleAllowed('viewer', 'exclude_object')).toBe(false)
  expect(controlRoleAllowed('operator', 'exclude_object')).toBe(true)
  expect(controlSourceState('exclude_object', 'idle')).toBe(false)
  expect(
    ControlArguments.safeParse({
      action: 'exclude_object',
      args: { name: 'part\nM112' },
    }).success,
  ).toBe(false)
})
