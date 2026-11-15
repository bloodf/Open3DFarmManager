export type MoonrakerFirmware = {
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

function version(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, 64)
    : undefined
}

export async function readMoonrakerFirmware(client: {
  request(method: string, params: object): Promise<unknown>
}): Promise<MoonrakerFirmware | undefined> {
  const result = record(await client.request('machine.update.status', {}))
  const versions = record(result?.version_info)
  if (!versions) return undefined
  const components: NonNullable<MoonrakerFirmware['components']> = []
  let updateAvailable: boolean | undefined
  for (const name of ['klipper', 'moonraker', 'system']) {
    const item = record(versions[name])
    if (!item) continue
    const current = version(item.version)
    const latest = version(item.remote_version)
    if (current)
      components.push({ name, current, ...(latest ? { latest } : {}) })
    if (typeof item.is_valid === 'boolean' && !item.is_valid) continue
    if (typeof item.update_available === 'boolean') {
      updateAvailable = (updateAvailable ?? false) || item.update_available
    } else if (current && latest) {
      updateAvailable = (updateAvailable ?? false) || current !== latest
    }
  }
  if (!components.length && updateAvailable === undefined) return undefined
  const klipper = components.find((component) => component.name === 'klipper')
  return {
    ...(klipper ? { current: klipper.current } : {}),
    ...(klipper?.latest ? { latest: klipper.latest } : {}),
    ...(updateAvailable === undefined ? {} : { updateAvailable }),
    ...(components.length ? { components } : {}),
  }
}
