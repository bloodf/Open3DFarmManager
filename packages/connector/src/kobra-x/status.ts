import type { KobraXPrinterState } from './gate.ts'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'
import { record } from './discovery.ts'

const preparing = new Set([
  'checking',
  'hotbed_heating',
  'nozzle_heating',
  'ace_filament_unfeeding',
  'ace_filament_feeding',
  'nozzle_purging',
  'nozzle_wiping',
  'nozzle_cooling',
  'auto_leveling',
  'z_offset_calibrating',
  'frequency_sweeping',
  'hotbed_cooling_off',
  'nozzle_cooling_off',
])

function nonnegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

export function createKobraXStatus(printerKey: string, address: string) {
  let status: PrinterState & { state: KobraXPrinterState } = {
    printerKey,
    state: 'offline',
    observedAt: Date.now(),
  }
  let cameraUrl: string | undefined
  let ended = false

  function report(type: string, payload: unknown) {
    const message = record(payload)
    if (type === 'print' && message.action === 'getSliceParam') return
    const data = record(message.data)
    const next = {
      ...status,
      observedAt: Date.now(),
      progress: status.progress ?? 0,
    }
    if (type === 'info' || type === 'status') {
      if (data.state === 'free') {
        if (next.state !== 'error') next.state = 'idle'
        next.progress = 0
        delete next.filename
        delete next.currentLayer
        delete next.printDuration
      }
      if (data.state === 'busy' && next.state !== 'paused')
        next.state = 'printing'
      if (
        typeof data.version === 'string' &&
        data.version.length <= 64 &&
        data.version
      ) {
        next.firmware = { current: data.version }
      }
      const url = record(data.urls).rtspUrl
      if (typeof url === 'string') {
        try {
          const parsed = new URL(url)
          if (
            parsed.protocol === 'http:' &&
            parsed.hostname === address &&
            !parsed.username &&
            !parsed.password
          )
            cameraUrl = parsed.href
        } catch {
          // Ignore malformed camera URLs.
        }
      }
    }
    if (type !== 'multiColorBox') {
      if (type === 'info' || type === 'print' || type === 'fan') {
        const percent =
          data.fan_speed_pct ?? record(data.settings).fan_speed_pct
        if (
          typeof percent === 'number' &&
          Number.isInteger(percent) &&
          percent >= 0 &&
          percent <= 100
        )
          next.fans = { part: percent }
      }
      const lights =
        type === 'info' && Array.isArray(data.lights)
          ? data.lights
          : type === 'light'
            ? [data]
            : []
      const light = lights.map(record).find((entry) => entry.type === 3)
      if (light && (light.status === 0 || light.status === 1))
        next.light = { chamber: light.status === 1 }

      const temperatures = type === 'info' ? record(data.temp) : data
      const tool = nonnegative(temperatures.curr_nozzle_temp)
      const bed = nonnegative(temperatures.curr_hotbed_temp)
      if (tool !== undefined) next.toolTemperatureCelsius = tool
      if (bed !== undefined) next.bedTemperatureCelsius = bed
    }
    if (type === 'print') {
      const phase = message.state
      if (typeof data.filename === 'string')
        next.filename = data.filename.slice(0, 255)
      if (phase === 'printing' || phase === 'paused') {
        next.state = phase
        const progress = nonnegative(data.progress)
        const layer = nonnegative(data.curr_layer)
        const elapsed = nonnegative(data.print_time)
        if (progress !== undefined)
          next.progress = Math.min(100, progress) / 100
        if (layer !== undefined && Number.isInteger(layer))
          next.currentLayer = layer
        if (elapsed !== undefined) next.printDuration = elapsed
        ended = false
        delete next.lastJob
      } else if (typeof phase === 'string' && preparing.has(phase)) {
        next.state = 'printing'
        ended = false
        delete next.lastJob
      } else if (phase === 'finished' || phase === 'stoped') {
        const outcome =
          phase === 'finished'
            ? 'completed'
            : message.code === undefined ||
                message.code === 0 ||
                message.code === 200
              ? 'cancelled'
              : 'failed'
        next.state = outcome === 'failed' ? 'error' : 'idle'
        if (outcome === 'completed') next.progress = 1
        if (!ended)
          next.lastJob = {
            outcome,
            endedAt: next.observedAt,
            ...(next.filename !== undefined ? { filename: next.filename } : {}),
            ...(next.printDuration !== undefined
              ? { printDuration: next.printDuration }
              : {}),
          }
        ended = true
      }
    }
    if (type === 'multiColorBox' && Array.isArray(data.multi_color_box)) {
      next.materials = data.multi_color_box
        .flatMap((value, boxIndex) => {
          const box = record(value)
          if (!Array.isArray(box.slots)) return []
          return box.slots.map((value, slotIndex) => {
            const slot = record(value)
            const remaining = nonnegative(slot.consumables_percent)
            const rgb = slot.color
            const colorHex =
              Array.isArray(rgb) &&
              rgb.length === 3 &&
              rgb.every(
                (channel) =>
                  Number.isInteger(channel) && channel >= 0 && channel <= 255,
              )
                ? Buffer.from([...rgb, 255])
                    .toString('hex')
                    .toUpperCase()
                : undefined
            return {
              slot: `${boxIndex + 1}-${slotIndex + 1}`,
              active: (slot.index ?? slotIndex) === box.loaded_slot,
              ...(typeof slot.type === 'string'
                ? { materialType: slot.type.slice(0, 64) }
                : {}),
              ...(remaining !== undefined && remaining <= 100
                ? { remainingPercent: remaining }
                : {}),
              ...(colorHex ? { colorHex } : {}),
            }
          })
        })
        .slice(0, 17)
    }
    status = next
  }

  return {
    report,
    snapshot: () => status,
    cameraUrl: () => cameraUrl,
    disconnect() {
      status = { ...status, state: 'offline', observedAt: Date.now() }
      cameraUrl = undefined
    },
  }
}
