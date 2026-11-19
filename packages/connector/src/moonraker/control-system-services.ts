import { ServiceArguments } from '../../../farm-protocol/src/control-actions.ts'
import { count, fields, string, type Fields } from './detail-normalize.ts'

const methods = {
  klipper_restart: 'printer.restart',
  firmware_restart: 'printer.firmware_restart',
  moonraker_restart: 'server.restart',
} as const

export function serviceCommand(args: unknown) {
  return { method: methods[ServiceArguments.parse(args).op] }
}

function metric(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export async function readSystemServices(
  request: (method: string, params?: Fields) => Promise<unknown>,
) {
  const [process, update, server] = await Promise.all([
    request('machine.proc_stats').catch(() => undefined),
    request('machine.update.status', { refresh: false }).catch(() => undefined),
    request('server.info').catch(() => undefined),
  ])
  const { system_cpu_usage, system_memory, cpu_temp } = fields(process)
  const memory = metric(fields(system_memory).used)
  const cpu = metric(fields(system_cpu_usage).cpu)
  const state = string(fields(server).klippy_state)
  return {
    ...(state && { firmware: { state, message: '' } }),
    ...(process != null && {
      host: {
        cpuLoad:
          cpu === undefined ? undefined : Math.min(100, Math.max(0, cpu)),
        memoryBytes: memory === undefined ? undefined : count(memory * 1024),
        temperatureC: metric(cpu_temp),
      },
    }),
    ...(update != null && {
      updates: Object.entries(fields(fields(update).version_info))
        .slice(0, 64)
        .flatMap(([key, value]) => {
          const name = string(key)
          const component = fields(value)
          return name
            ? [
                {
                  name,
                  installed: string(component.version),
                  available: string(component.remote_version),
                },
              ]
            : []
        }),
    }),
  }
}
