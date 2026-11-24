import { record } from './discovery.ts'
import { reportRefusal, type KobraXReport } from './requests.ts'

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

/** A `print` report state that names where a job stands. */
export function isKobraXJobPhase(state: string | undefined) {
  return (
    state !== undefined &&
    (state === 'printing' ||
      state === 'paused' ||
      state === 'finished' ||
      state === 'stoped' ||
      preparing.has(state))
  )
}

export interface KobraXAceSlotFact {
  index: number
  materialType?: string
  /** Remaining material in percent, when the printer reports it. */
  remainingPercent?: number
  /** Nominal spool weight in grams, when the printer reports it. */
  weightGrams?: number
  colorHex?: string
}

export interface KobraXAceBoxFact {
  id: number
  autoFeed: boolean | undefined
  loadedSlot: number
  dryingActive: boolean
  slots: readonly KobraXAceSlotFact[]
}

export interface KobraXFacts {
  /** `info.state`: `busy` also covers homing and other non-print work. */
  infoState: 'free' | 'busy' | undefined
  /** A job is in preparation, printing or paused. */
  jobActive: boolean
  jobPhase: string | undefined
  taskId: string | undefined
  filename: string | undefined
  /** Support flags (`*_support`) from `info.features`. */
  features: Readonly<Record<string, boolean>>
  boxes: readonly KobraXAceBoxFact[]
  skippedObjects: readonly number[]
}

/** LAN print indices are distinct across the holder and ACE in a mixed report. */
export function kobraXPrintSlots(boxes: KobraXFacts['boxes']) {
  const hasHolder = boxes.some((box) => box.id === -1)
  const hasAce = boxes.some((box) => box.id >= 0)
  return boxes.flatMap((box) => {
    if (box.id < -1 || box.id > 3) return []
    const count = box.id === -1 && hasAce ? 3 : 4
    const offset = box.id < 0 ? 0 : box.id * 4 + (hasHolder ? 4 : 0)
    return box.slots
      .filter((slot) => slot.index >= 0 && slot.index < count)
      .map((slot) => ({ boxId: box.id, slot, amsIndex: offset + slot.index }))
  })
}

function nonnegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function parseBoxes(value: unknown): KobraXAceBoxFact[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 4).map((raw, position) => {
    const box = record(raw)
    const slots = Array.isArray(box.slots) ? box.slots : []
    const drying = record(box.drying_status)
    return {
      id: Number.isInteger(box.id) ? (box.id as number) : position,
      autoFeed:
        typeof box.auto_feed === 'number'
          ? box.auto_feed !== 0
          : typeof box.auto_feed === 'boolean'
            ? box.auto_feed
            : undefined,
      loadedSlot: Number.isInteger(box.loaded_slot)
        ? (box.loaded_slot as number)
        : -1,
      dryingActive: typeof drying.status === 'number' && drying.status !== 0,
      slots: slots.slice(0, 4).map((rawSlot, slotPosition) => {
        const slot = record(rawSlot)
        const remaining = nonnegative(slot.consumables_percent)
        const weight = nonnegative(slot.weight)
        const rgb = slot.color
        return {
          index: Number.isInteger(slot.index)
            ? (slot.index as number)
            : slotPosition,
          ...(typeof slot.type === 'string'
            ? { materialType: slot.type.slice(0, 64) }
            : {}),
          ...(remaining !== undefined && remaining <= 100
            ? { remainingPercent: remaining }
            : {}),
          ...(weight !== undefined ? { weightGrams: weight } : {}),
          ...(Array.isArray(rgb) &&
          rgb.length === 3 &&
          rgb.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
            ? {
                colorHex: Buffer.from([...(rgb as number[]), 255])
                  .toString('hex')
                  .toUpperCase(),
              }
            : {}),
        }
      }),
    }
  })
}

/** Live facts that gate control decisions. Reports are the only input; nothing is guessed. */
export function createKobraXFacts() {
  let facts: KobraXFacts = {
    infoState: undefined,
    jobActive: false,
    jobPhase: undefined,
    taskId: undefined,
    filename: undefined,
    features: {},
    boxes: [],
    skippedObjects: [],
  }
  const listeners = new Set<
    (next: KobraXFacts, previous: KobraXFacts) => void
  >()

  function report(input: KobraXReport) {
    if (reportRefusal(input) !== null) return
    if (input.type === 'print' && input.action === 'getSliceParam') return
    const { data } = input
    const previous = facts
    const next: { -readonly [K in keyof KobraXFacts]: KobraXFacts[K] } = {
      ...facts,
    }
    if (input.type === 'info' || input.type === 'status') {
      if (data.state === 'free' || data.state === 'busy')
        next.infoState = data.state
      if (data.state === 'free' && data.project == null) {
        next.jobActive = false
        next.jobPhase = undefined
        next.taskId = undefined
        next.filename = undefined
      }
      const project = record(data.project)
      if (Object.keys(project).length > 0 && data.state === 'busy') {
        next.jobActive = true
        if (typeof project.filename === 'string')
          next.filename = project.filename.slice(0, 255)
        if (typeof project.taskid === 'string') next.taskId = project.taskid
      }
      const features = record(data.features)
      if (Object.keys(features).length > 0)
        next.features = Object.freeze(
          Object.fromEntries(
            Object.entries(features)
              .filter(([, value]) => typeof value === 'boolean')
              .slice(0, 64),
          ) as Record<string, boolean>,
        )
      const boxes = parseBoxes(data.multi_color_box)
      if (boxes) next.boxes = boxes
    }
    if (input.type === 'print') {
      const phase = input.state
      if (typeof data.filename === 'string')
        next.filename = data.filename.slice(0, 255)
      if (typeof data.taskid === 'string') next.taskId = data.taskid
      if (typeof phase === 'string') {
        if (
          phase === 'printing' ||
          phase === 'paused' ||
          preparing.has(phase)
        ) {
          next.jobActive = true
          next.jobPhase = phase
        } else if (phase === 'finished' || phase === 'stoped') {
          next.jobActive = false
          next.jobPhase = phase
        }
      }
    }
    if (input.type === 'multiColorBox') {
      const boxes = parseBoxes(data.multi_color_box)
      if (boxes) next.boxes = boxes
    }
    if (input.type === 'skip' && Array.isArray(data.skipped_objects))
      next.skippedObjects = data.skipped_objects.filter((id): id is number =>
        Number.isInteger(id),
      )
    facts = Object.freeze(next)
    for (const listener of [...listeners]) listener(facts, previous)
  }

  return {
    report,
    get: () => facts,
    subscribe(listener: (next: KobraXFacts, previous: KobraXFacts) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset() {
      facts = { ...facts, infoState: undefined, jobActive: false }
    },
  }
}
export type KobraXFactsTracker = ReturnType<typeof createKobraXFacts>
