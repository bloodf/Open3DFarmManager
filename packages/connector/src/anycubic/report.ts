export function decodeAnycubicReport(payload: Buffer) {
  if (payload.length > 65536) return { kind: 'invalid' as const }
  try {
    const envelope: unknown = JSON.parse(payload.toString('utf8'))
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      return { kind: 'invalid' as const }
    const data = 'data' in envelope ? envelope.data : envelope
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { kind: 'invalid' as const }
    const observation: Record<string, string | number> = {}
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
