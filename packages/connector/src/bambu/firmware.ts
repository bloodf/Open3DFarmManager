import { firmwareUpdateAvailable } from '@open3dfarmmanager/farm-protocol'
import { decodeBambuVersion } from './version.ts'

type Firmware = {
  current?: string
  latest?: string
  updateAvailable?: boolean
  components?: { name: string; current: string; latest?: string }[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    ? value
    : undefined
}

/** Maps observed version modules and OTA report fields without initiating an update. */
export function mapBambuFirmware(
  version: unknown,
  report?: unknown,
): Firmware | undefined {
  const decoded = decodeBambuVersion(version)
  const print = record(record(report)?.print) ?? record(report)
  const upgrade = record(print?.upgrade_state)
  const list = Array.isArray(upgrade?.new_ver_list) ? upgrade.new_ver_list : []
  const latestByName = new Map<string, string>()
  for (const item of list.slice(0, 256)) {
    const entry = record(item)
    const name = text(entry?.module)
    const latest = text(entry?.version)
    if (name && latest && !latestByName.has(name))
      latestByName.set(name, latest)
  }
  const components = decoded?.modules
    .flatMap((module) => {
      const name = text(module.name)
      const current = text(module.firmware)
      if (!name || !current) return []
      const latest = latestByName.get(name)
      return [{ name, current, ...(latest ? { latest } : {}) }]
    })
    .slice(0, 16)
  const current = text(decoded?.firmware)
  const latest = latestByName.get('ota')
  const updateAvailable = firmwareUpdateAvailable(current, latest)
  if (!current && !latest && !components?.length) return undefined
  return {
    ...(current ? { current } : {}),
    ...(latest ? { latest } : {}),
    ...(updateAvailable !== undefined ? { updateAvailable } : {}),
    ...(components?.length ? { components } : {}),
  }
}
