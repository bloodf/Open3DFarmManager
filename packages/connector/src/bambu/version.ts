import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'

export function buildGetVersionRequest(sequenceId: string) {
  return { info: { command: 'get_version', sequence_id: sequenceId } }
}

type VersionModule = { name: string; firmware?: string; product?: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    ? value
    : undefined
}

export function decodeBambuVersion(
  payload: unknown,
): { model?: string; firmware?: string; modules: VersionModule[] } | undefined {
  let parsed: unknown = payload
  try {
    // Apply the same bounds to objects and wire messages.
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (typeof json !== 'string') return undefined
    parsed = parseBoundedJson(json, {
      maxBytes: 128 * 1024,
      maxDepth: 16,
      maxValues: 8192,
      maxStringChars: 16384,
    })
  } catch {
    return undefined
  }
  const info = record(record(parsed)?.info)
  if (
    !info ||
    info.command !== 'get_version' ||
    !Array.isArray(info.module) ||
    info.module.length > 256
  )
    return undefined
  const modules: VersionModule[] = []
  for (const item of info.module) {
    const module = record(item)
    const name = text(module?.name)
    if (!name) continue
    const firmware = text(module?.sw_ver)
    const product = text(module?.product_name)
    modules.push({
      name,
      ...(firmware ? { firmware } : {}),
      ...(product ? { product } : {}),
    })
  }
  const ota = modules.find((module) => module.name === 'ota')
  return {
    ...(ota?.product ? { model: ota.product } : {}),
    ...(ota?.firmware ? { firmware: ota.firmware } : {}),
    modules,
  }
}
