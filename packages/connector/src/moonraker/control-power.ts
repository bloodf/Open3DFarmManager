import { z } from 'zod'
import { PowerArguments } from '../../../farm-protocol/src/control-actions.ts'
import { fields } from './detail-normalize.ts'

export const POWER_METHOD = 'machine.device_power.devices'
export const POWER_MARKER = 'moonraker_component power'

const device = z.object({
  device: PowerArguments.shape.device,
  status: z.string(),
  locked_while_printing: z.boolean(),
})
const catalogue = z.object({ devices: z.array(device).max(64) })

export async function readPowerDevices(
  request: (method: string) => Promise<unknown>,
) {
  return catalogue.parse(await request(POWER_METHOD)).devices.map((entry) => ({
    name: entry.device,
    status:
      entry.status === 'on'
        ? ('on' as const)
        : entry.status === 'off'
          ? ('off' as const)
          : ('unknown' as const),
    locked: entry.locked_while_printing,
  }))
}

export function powerCommand(args: unknown, objects: readonly string[]) {
  if (!objects.includes(POWER_MARKER)) throw new Error('Power unavailable')
  const { device, on } = PowerArguments.parse(args)
  return {
    method: 'machine.device_power.post_device',
    params: { device, action: on ? 'on' : 'off' },
  }
}

export class PowerRefused extends Error {
  readonly refusal: 'state' | 'unsupported-action' | 'invalid-command'

  constructor(refusal: 'state' | 'unsupported-action' | 'invalid-command') {
    super(`Power operation refused: ${refusal}`)
    this.refusal = refusal
  }
}

type Read = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>

export async function authorizePower(
  args: unknown,
  objects: readonly string[],
  read: Read,
) {
  if (!objects.includes(POWER_MARKER))
    throw new PowerRefused('unsupported-action')
  const parsed = PowerArguments.safeParse(args)
  if (!parsed.success) throw new PowerRefused('invalid-command')
  const { device, on } = parsed.data
  const devices = await readPowerDevices(read)
  const matches = devices.filter((entry) => entry.name === device)
  if (matches.length !== 1) throw new PowerRefused('unsupported-action')
  if (matches[0]?.locked || matches[0]?.status === 'unknown')
    throw new PowerRefused('state')
  if (on) return

  // Moonraker provides no reliable designation for the printer's power relay.
  // Require a stopped, non-heating printer before switching any relay off.
  const heaters = objects.filter((name) =>
    /^(extruder\d*|heater_bed|heater_generic .+)$/.test(name),
  )
  if (!heaters.length) throw new PowerRefused('state')
  const status = fields(
    fields(
      await read('printer.objects.query', {
        objects: {
          print_stats: ['state'],
          ...Object.fromEntries(
            heaters.map((name) => [name, ['target', 'power']]),
          ),
        },
      }),
    ).status,
  )
  const state = fields(status.print_stats).state
  if (
    !['standby', 'complete', 'cancelled', 'idle'].includes(String(state)) ||
    heaters.some(
      (name) =>
        fields(status[name]).target !== 0 || fields(status[name]).power !== 0,
    )
  )
    throw new PowerRefused('state')
}

export async function executePower<T, R>(
  args: unknown,
  objects: readonly string[],
  command: T,
  request: (id: number, wire: string) => Promise<unknown>,
  send: (
    wire: string,
    command: T,
    cap: number,
    accepts: (result: unknown) => boolean,
  ) => Promise<R>,
  close: () => Promise<void>,
): Promise<R> {
  let id = 11
  const read: Read = (method, params) => {
    const requestId = id++
    return request(
      requestId,
      JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    )
  }
  try {
    await authorizePower(args, objects, read)
  } catch (error) {
    await close()
    throw error instanceof PowerRefused ? error : new PowerRefused('state')
  }
  const call = powerCommand(args, objects)
  return send(
    JSON.stringify({ jsonrpc: '2.0', id: 2, ...call }),
    command,
    5000,
    (result) => {
      const reply = fields(result)
      return (
        reply.device === call.params.device &&
        reply.status === call.params.action
      )
    },
  )
}
