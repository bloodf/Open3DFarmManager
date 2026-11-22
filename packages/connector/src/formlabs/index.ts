// PreForm API v1 device contract: https://developer.formlabs.com/api-reference/devices/
// Firmware reference: https://formlabs.com/support/Firmware-Release-Notes/
const models = ['Form 4', 'Form 4L'] as const
const localConnections = ['UNKNOWN', 'USB', 'WIFI', 'ETHERNET']

function malformed(): never {
  throw new Error('Malformed PreForm device reply')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed()
  return value as Record<string, unknown>
}

function string(value: unknown) {
  if (typeof value !== 'string') malformed()
  return value
}

function quantity(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    malformed()
  return value
}

function parseDevices(reply: unknown) {
  const { count, devices } = record(reply)
  if (!Array.isArray(devices) || count !== devices.length) malformed()
  const seen = new Set<string>()
  return devices.flatMap((entry: unknown) => {
    const device = record(entry)
    const model = models.find((name) => name === device.product_name)
    if (!model) return []
    if (typeof device.is_connected !== 'boolean') malformed()
    const connection = string(device.connection_type)
    if (!device.is_connected || !localConnections.includes(connection))
      return []

    const id = string(device.id)
    const firmware = string(device.firmware_version)
    if (!id.trim() || !firmware.trim() || seen.has(id)) malformed()
    seen.add(id)
    const remainingMs = quantity(device.estimated_print_time_remaining_ms)
    if (!Number.isSafeInteger(remainingMs)) malformed()
    const cartridges = Object.entries(record(device.cartridge_data)).map(
      ([id, value]) => {
        const cartridge = record(value)
        return {
          id,
          materialCode: string(cartridge.cartridgeMaterialCode),
          estimatedDispensedMl: quantity(
            cartridge.cartridgeEstimatedVolumeDispensed_mL,
          ),
          originalVolumeMl: quantity(cartridge.cartridgeOriginalVolume_mL),
        }
      },
    )
    return [
      {
        id,
        model,
        firmware,
        connection,
        statusText: string(device.status),
        remainingMs,
        tankId: string(device.tank_id) || null,
        tankMaterialCode: string(device.tank_material_code) || null,
        cartridges,
      },
    ]
  })
}

export function createFormlabsAdapter(origin: string, timeoutMs = 10_000) {
  const endpoint = new URL(origin)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Expected a PreForm HTTP(S) origin')
  }

  async function read(path: string, body?: object) {
    const response = await fetch(new URL(path, endpoint), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body && JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`PreForm HTTP ${response.status}`)
    }

    if (!response.body) malformed()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024 * 1024) {
          await reader.cancel()
          throw new Error('Oversized PreForm device reply')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }

    let reply: unknown
    try {
      reply = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      )
    } catch {
      malformed()
    }
    return parseDevices(reply)
  }

  async function list() {
    return read('/v1/device/list/')
  }

  return {
    list,
    discover: () => read('/v1/device/discover/', { timeout_seconds: 2 }),
    async readStatus(id: string) {
      const devices = await list()
      return devices.find((device) => device.id === id) ?? null
    },
  }
}
