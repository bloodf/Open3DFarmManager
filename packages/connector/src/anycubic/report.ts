export function decodeAnycubicReport(payload: Buffer) {
  if (payload.length > 65536) return { kind: 'invalid' as const }
  try {
    const envelope: unknown = JSON.parse(payload.toString('utf8'))
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      return { kind: 'invalid' as const }
    const data = 'data' in envelope ? envelope.data : envelope
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { kind: 'invalid' as const }
    const observation: Record<string, unknown> = {}
    const fields = {
      curr_nozzle_temp: 'toolTemperatureCelsius',
      curr_hotbed_temp: 'bedTemperatureCelsius',
      progress: 'progress',
      curr_layer: 'currentLayer',
      total_layers: 'totalLayer',
    }
    for (const [source, target] of Object.entries(fields)) {
      const value = (data as Record<string, unknown>)[source]
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        (source !== 'progress' || value <= 100)
      )
        observation[target] = value
    }
    const row = data as Record<string, unknown>
    // LAN field names and ACE slot shape: https://github.com/chrisfore/anycubic_ha_local/blob/main/custom_components/anycubic/anycubic_local/models.py
    const fans: Record<string, number> = {}
    for (const [source, target] of Object.entries({
      fan_speed_pct: 'part',
      aux_fan_speed_pct: 'aux',
      box_fan_level: 'chamber',
    })) {
      const value = row[source]
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 100
      )
        fans[target] = value
    }
    if (Object.keys(fans).length) observation.fans = fans
    const lights = Array.isArray(row.lights) ? row.lights : [row]
    const chamber = lights.find(
      (value: unknown) =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).type === 2,
    ) as Record<string, unknown> | undefined
    if (chamber && (chamber.status === 0 || chamber.status === 1))
      observation.light = { chamber: chamber.status === 1 }
    if (
      Array.isArray(row.multi_color_box) &&
      row.multi_color_box.length <= 17
    ) {
      const materials: Record<string, unknown>[] = []
      for (const box of row.multi_color_box) {
        if (
          !box ||
          typeof box !== 'object' ||
          !Number.isInteger(box.id) ||
          box.id < -1 ||
          box.id > 3 ||
          !Array.isArray(box.slots)
        )
          continue
        for (const slot of box.slots) {
          if (
            !slot ||
            typeof slot !== 'object' ||
            !Number.isInteger(slot.index) ||
            slot.index < 0 ||
            slot.index > 3
          )
            continue
          const material: Record<string, unknown> = {
            slot: `${box.id}:${slot.index}`,
          }
          if (
            typeof slot.type === 'string' &&
            slot.type.length > 0 &&
            slot.type.length <= 64
          )
            material.materialType = slot.type
          if (
            Array.isArray(slot.color) &&
            slot.color.length >= 3 &&
            slot.color
              .slice(0, 3)
              .every(
                (v: unknown) =>
                  typeof v === 'number' &&
                  Number.isInteger(v) &&
                  v >= 0 &&
                  v <= 255,
              )
          )
            material.colorHex =
              slot.color
                .slice(0, 3)
                .map((v: number) =>
                  v.toString(16).padStart(2, '0').toUpperCase(),
                )
                .join('') + 'FF'
          if (
            typeof slot.consumables_percent === 'number' &&
            Number.isFinite(slot.consumables_percent) &&
            slot.consumables_percent >= 0 &&
            slot.consumables_percent <= 100
          )
            material.remainingPercent = slot.consumables_percent
          if (
            typeof slot.status === 'number' &&
            Number.isInteger(slot.status) &&
            slot.status >= 0
          )
            material.active = slot.status === 5
          materials.push(material)
        }
      }
      if (materials.length <= 17) observation.materials = materials
    }
    if (typeof row.filename === 'string' && row.filename.length <= 1024)
      observation.filename = row.filename
    if (
      typeof row.state === 'string' &&
      ['idle', 'printing', 'paused', 'error', 'finished'].includes(row.state)
    )
      observation.state = row.state
    return Object.keys(observation).length
      ? { kind: 'observation' as const, ...observation }
      : { kind: 'ignored' as const }
  } catch {
    return { kind: 'invalid' as const }
  }
}
