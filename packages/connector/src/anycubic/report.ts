import { boundPrinterString } from '@open3dfarmmanager/farm-protocol'
import {
  anycubicBoxMaterials,
  anycubicExternalMaterial,
  mergeAnycubicMaterials,
} from './ace.ts'

function estimateSeconds(minutes: unknown) {
  return typeof minutes === 'number' &&
    Number.isSafeInteger(minutes) &&
    minutes >= 0 &&
    Number.isSafeInteger(minutes * 60)
    ? minutes * 60
    : undefined
}

export function decodeAnycubicReport(payload: Buffer) {
  if (payload.length > 65536) return { kind: 'invalid' as const }
  try {
    const envelope: unknown = JSON.parse(payload.toString('utf8'))
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      return { kind: 'invalid' as const }
    const type = 'type' in envelope ? envelope.type : undefined
    const failed = 'state' in envelope && envelope.state === 'failed'
    const data = 'data' in envelope ? envelope.data : envelope
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { kind: 'invalid' as const }
    const row = data as Record<string, unknown>
    // The external spool's own `type` and `status` are not printer telemetry.
    if (type === 'extfilbox') {
      const external = failed ? undefined : anycubicExternalMaterial(row)
      return external
        ? { kind: 'observation' as const, materials: [external] }
        : { kind: 'ignored' as const }
    }
    const project =
      row.project &&
      typeof row.project === 'object' &&
      !Array.isArray(row.project)
        ? (row.project as Record<string, unknown>)
        : undefined
    // LAN info reports device availability separately from the project phase.
    let state = row.state
    if (state === 'free') state = 'idle'
    if (state === 'busy' || state === undefined) {
      state = project?.state
      if (state === 'printing' && project?.pause === 1) state = 'paused'
      if (state === 'finish') state = 'finished'
    }
    const active = state === 'printing' || state === 'paused'
    const knownState =
      active || state === 'idle' || state === 'error' || state === 'finished'
    // Preparation and unrecognized phases provide no terminal job evidence.
    const estimateBlocked = state !== undefined && !knownState
    const observation: Record<string, unknown> = {}
    if (knownState) observation.state = state
    const fields = {
      curr_nozzle_temp: 'toolTemperatureCelsius',
      curr_hotbed_temp: 'bedTemperatureCelsius',
      progress: 'progress',
      curr_layer: 'currentLayer',
      total_layers: 'totalLayer',
    }
    for (const [source, target] of Object.entries(fields)) {
      const value = row[source] ?? project?.[source]
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        (source !== 'progress' || value <= 100)
      )
        observation[target] = value
    }
    // Simulator-verified, hardware-unqualified. Kobra 3 LAN reports minutes:
    // https://github.com/rvanderp3/kobra-connect#known-limitations
    // The estimate is in info's project or directly in a print progress report:
    // https://github.com/chrisfore/anycubic_ha_local/blob/main/custom_components/anycubic/anycubic_local/models.py
    if (active || state === undefined) {
      const seconds =
        estimateSeconds(row.remain_time) ??
        estimateSeconds(project?.remain_time)
      if (seconds !== undefined) observation.estimatedRemainingSeconds = seconds
    }
    // LAN field names: https://github.com/chrisfore/anycubic_ha_local/blob/main/custom_components/anycubic/anycubic_local/models.py
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
    // `status` 5 marks the active slot only when no `loaded_slot` is reported.
    const boxes = failed
      ? undefined
      : anycubicBoxMaterials(row.multi_color_box, {
          readyStatusIsActive: true,
        })
    if (boxes) observation.materials = mergeAnycubicMaterials(undefined, boxes)
    const filename = row.filename ?? project?.filename
    if (typeof filename === 'string' && filename.length <= 1024)
      observation.filename = boundPrinterString(filename)
    if (estimateBlocked)
      return { kind: 'observation' as const, ...observation, estimateBlocked }
    return Object.keys(observation).length
      ? { kind: 'observation' as const, ...observation }
      : { kind: 'ignored' as const }
  } catch {
    return { kind: 'invalid' as const }
  }
}
