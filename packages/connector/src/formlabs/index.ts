import { isIP } from 'node:net'
import { z } from 'zod'

// Formlabs Local API 0.9.11: https://formlabs-dashboard-api-resources.s3.us-east-1.amazonaws.com/formlabs-local-api-v0.9.11.html
const Device = z.object({
  id: z.string().min(1).max(128),
  product_name: z.string().min(1).max(128),
  status: z.string().min(1).max(256),
  is_connected: z.boolean(),
  connection_type: z.string().optional(),
  ip_address: z.string().optional(),
  firmware_version: z.string().optional(),
})
const List = z.object({
  count: z.number().int().nonnegative(),
  devices: z.array(Device).max(256),
})
export type FormlabsDevice = z.infer<typeof Device>
export function isLocalFormlabsHost(host: string) {
  if (isIP(host) !== 4) return host === '::1'
  const parts = host.split('.').map(Number)
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  )
}
export const isSupportedFormlabsModel = (model: string) =>
  /^(form 4|form 4l)$/i.test(model.trim())

/** Only a locally configured IP host is accepted. Never follow redirects or issue writes. */
export function connectFormlabs(input: {
  host: string
  port: number
  staleAfterMs?: number
  now?: () => number
  timeoutMs?: number
}) {
  if (
    !isLocalFormlabsHost(input.host) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  )
    throw Error('Invalid PreForm host')
  const url = `http://${isIP(input.host) === 6 ? `[${input.host}]` : input.host}:${input.port}/devices/`
  const now = input.now ?? Date.now
  let snapshot:
    | {
        devices: FormlabsDevice[]
        retrievedAt: number
        printerObservedAt: null
      }
    | undefined
  return {
    capabilities: { status: true, dispatch: false, control: false } as const,
    async refresh() {
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
        })
        if (!response.ok) throw Error('PreForm host unavailable')
        const body = await response.text()
        if (body.length > 262144) throw Error('PreForm response too large')
        const list = List.parse(JSON.parse(body))
        if (list.count !== list.devices.length)
          throw Error('Invalid PreForm device count')
        snapshot = {
          devices: list.devices,
          retrievedAt: now(),
          printerObservedAt: null,
        }
        return snapshot
      } catch (error) {
        snapshot = undefined
        throw error
      }
    },
    snapshot() {
      const age = snapshot ? now() - snapshot.retrievedAt : -1
      return age >= 0 && age < (input.staleAfterMs ?? 30000)
        ? snapshot
        : undefined
    },
    command: (_command: unknown) => ({
      ok: false as const,
      reason: 'unsupported' as const,
    }),
  }
}
