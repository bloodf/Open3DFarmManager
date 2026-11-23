import { record } from './discovery.ts'
import {
  runGated,
  type KobraXCall,
  type KobraXControlContext,
} from './context.ts'
import {
  refusedLocally,
  type KobraXOutcome,
  type KobraXReport,
} from './requests.ts'

/** Local safety bounds. The clean-room spec documents no drying limits. */
export const MIN_DRYING_CELSIUS = 35
export const MAX_DRYING_CELSIUS = 60
export const MAX_DRYING_MINUTES = 24 * 60

export interface KobraXSlotEdit {
  brandName?: string
  materialName?: string
  type?: string
  /** RGB, each channel 0-255. */
  color?: readonly [number, number, number]
  weightGrams?: number
  remainingPercent?: number
}

const refuse = (reason: string) =>
  Promise.resolve<KobraXOutcome<never>>(refusedLocally(reason))
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 64 &&
  !/[\u0000-\u001f\u007f]/.test(value)

function firstBox(report: KobraXReport) {
  const boxes = report.data.multi_color_box
  return Array.isArray(boxes) ? record(boxes[0]) : {}
}
function boxReport(report: KobraXReport, id: number) {
  const boxes = report.data.multi_color_box
  return Array.isArray(boxes)
    ? boxes.map(record).find((box) => box.id === id)
    : undefined
}

export function createKobraXAce(context: KobraXControlContext) {
  const boxId = () => context.facts.get().boxes[0]?.id ?? 0
  return {
    feed(slot: number, call: KobraXCall, id = boxId()) {
      if (!Number.isInteger(slot) || slot < 0) return refuse('invalid-value')
      return runGated(context, { action: 'ace-feed', slot, boxId: id }, call, {
        type: 'multiColorBox',
        action: 'feed',
        data: { id, index: slot },
        effect: (report) => boxReport(report, id)?.loaded_slot === slot,
      })
    },

    retract(call: KobraXCall, id = boxId()) {
      const slot = context.facts
        .get()
        .boxes.find((box) => box.id === id)?.loadedSlot
      return runGated(
        context,
        { action: 'ace-retract', slot, boxId: id },
        call,
        {
          type: 'multiColorBox',
          action: 'retract',
          data: { id, index: slot },
          effect: (report) => boxReport(report, id)?.loaded_slot === -1,
        },
      )
    },

    startDrying(
      input: { targetCelsius: number; minutes: number },
      call: KobraXCall,
    ) {
      if (
        !Number.isInteger(input.targetCelsius) ||
        input.targetCelsius < MIN_DRYING_CELSIUS ||
        input.targetCelsius > MAX_DRYING_CELSIUS ||
        !Number.isInteger(input.minutes) ||
        input.minutes < 1 ||
        input.minutes > MAX_DRYING_MINUTES
      )
        return refuse('invalid-value')
      return runGated(context, { action: 'ace-dry-start' }, call, {
        type: 'multiColorBox',
        action: 'startDrying',
        data: {
          id: boxId(),
          target_temp: input.targetCelsius,
          duration: input.minutes,
        },
        effect(report) {
          const drying = record(firstBox(report).drying_status)
          return (
            drying.status !== 0 && drying.target_temp === input.targetCelsius
          )
        },
      })
    },

    stopDrying(call: KobraXCall) {
      return runGated(context, { action: 'ace-dry-stop' }, call, {
        type: 'multiColorBox',
        action: 'stopDrying',
        data: { id: boxId() },
        effect: (report) => record(firstBox(report).drying_status).status === 0,
      })
    },

    setAutoFeed(enabled: boolean, call: KobraXCall) {
      const value = enabled ? 1 : 0
      return runGated(context, { action: 'ace-auto-feed' }, call, {
        type: 'multiColorBox',
        action: 'setAutoFeed',
        data: { id: boxId(), auto_feed: value },
        effect: (report) => firstBox(report).auto_feed === value,
      })
    },

    editSlot(slot: number, edit: KobraXSlotEdit, call: KobraXCall) {
      const known = context.facts
        .get()
        .boxes[0]?.slots.some((s) => s.index === slot)
      const fields: Record<string, unknown> = {}
      if (edit.brandName !== undefined) fields.brand_name = edit.brandName
      if (edit.materialName !== undefined)
        fields.material_name = edit.materialName
      if (edit.type !== undefined) fields.type = edit.type
      if (edit.color !== undefined) fields.color = [...edit.color]
      if (edit.weightGrams !== undefined) fields.weight = edit.weightGrams
      if (edit.remainingPercent !== undefined)
        fields.consumables_percent = edit.remainingPercent
      const valid =
        Object.keys(fields).length > 0 &&
        (fields.brand_name === undefined || text(fields.brand_name)) &&
        (fields.material_name === undefined || text(fields.material_name)) &&
        (fields.type === undefined || text(fields.type)) &&
        (edit.color === undefined ||
          (edit.color.length === 3 &&
            edit.color.every(
              (c) => Number.isInteger(c) && c >= 0 && c <= 255,
            ))) &&
        (edit.weightGrams === undefined ||
          (Number.isFinite(edit.weightGrams) &&
            edit.weightGrams > 0 &&
            edit.weightGrams <= 10_000)) &&
        (edit.remainingPercent === undefined ||
          (Number.isFinite(edit.remainingPercent) &&
            edit.remainingPercent >= 0 &&
            edit.remainingPercent <= 100))
      if (!Number.isInteger(slot) || !known) return refuse('unknown-slot')
      if (!valid) return refuse('invalid-value')
      return runGated(context, { action: 'ace-slot-edit', slot }, call, {
        type: 'multiColorBox',
        action: 'editSlot',
        data: { id: boxId(), index: slot, ...fields },
        effect(report) {
          const slots = firstBox(report).slots
          const target = Array.isArray(slots)
            ? record(slots.find((s) => record(s).index === slot))
            : {}
          return Object.entries(fields).every(([key, value]) =>
            Array.isArray(value)
              ? JSON.stringify(target[key]) === JSON.stringify(value)
              : target[key] === value,
          )
        },
      })
    },
  }
}
