import { boundPrinterString } from '@open3dfarmmanager/farm-protocol'
import { readAnycubicPrintReport } from './alerts.ts'

function estimateSeconds(minutes: unknown) {
  return typeof minutes === 'number' &&
    Number.isSafeInteger(minutes) &&
    minutes >= 0 &&
    Number.isSafeInteger(minutes * 60)
    ? minutes * 60
    : undefined
}

// `print/report` names the file as "/<name>". The numbers of an ended job are
// its reset values, so only a pause keeps them (same reference).
function printObservation(
  print: NonNullable<ReturnType<typeof readAnycubicPrintReport>>,
  data: unknown,
) {
  const row =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}
  const observation: Record<string, unknown> = { state: print.state }
  if (typeof row.filename === 'string') {
    const filename = row.filename.slice(row.filename.lastIndexOf('/') + 1)
    if (filename && filename.length <= 1024)
      observation.filename = boundPrinterString(filename)
  }
  if (print.state === 'paused') {
    for (const [source, target] of [
      ['progress', 'progress'],
      ['curr_layer', 'currentLayer'],
      ['total_layers', 'totalLayer'],
    ] as const) {
      const value = row[source]
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        (source !== 'progress' || value <= 100)
      )
        observation[target] = value
    }
  }
  return {
    kind: 'observation' as const,
    ...observation,
    ...(print.alert ? { alert: print.alert } : {}),
  }
}

export function decodeAnycubicReport(payload: Buffer) {
  if (payload.length > 65536) return { kind: 'invalid' as const }
  try {
    const envelope: unknown = JSON.parse(payload.toString('utf8'))
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      return { kind: 'invalid' as const }
    const head = envelope as Record<string, unknown>
    // A refused request (any client's) changed nothing on the printer:
    // bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
    // src/kobracontrol/kobra.py, `succeeded` and `State._on_print`.
    if (typeof head.type === 'string' && head.state === 'failed')
      return { kind: 'ignored' as const }
    const print = readAnycubicPrintReport(head)
    if (print) return printObservation(print, head.data)
    const data = 'data' in envelope ? envelope.data : envelope
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { kind: 'invalid' as const }
    const row = data as Record<string, unknown>
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
    // A Kobra 3 `info/report` nests the temperatures under `temp`. Shape
    // re-typed (not captured) from
    // bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
    // tests/test_models.py `K3_INFO`.
    const temp =
      row.temp && typeof row.temp === 'object' && !Array.isArray(row.temp)
        ? (row.temp as Record<string, unknown>)
        : undefined
    const fields = {
      curr_nozzle_temp: 'toolTemperatureCelsius',
      curr_hotbed_temp: 'bedTemperatureCelsius',
      progress: 'progress',
      curr_layer: 'currentLayer',
      total_layers: 'totalLayer',
    }
    for (const [source, target] of Object.entries(fields)) {
      const value = row[source] ?? temp?.[source] ?? project?.[source]
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
            material.materialType = boundPrinterString(slot.type)
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
