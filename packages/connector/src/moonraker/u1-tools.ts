import { z } from 'zod'
import { parseToolStatus } from './discovery-parse.ts'
import { U1_TOOL_OBJECTS } from './u1-marker.ts'

/**
 * Snapmaker U1 tool mapping (read-only telemetry).
 *
 * The U1 is a four-tool Klipper machine whose Moonraker reports one extruder
 * object per tool: `extruder`, `extruder1`, `extruder2`, `extruder3`
 * (https://github.com/Snapmaker/u1-moonraker, tool count from
 * https://www.snapmaker.com/snapmaker-u1/specs). Nothing here runs for other
 * Klipper printers: the caller opts in by declaring the model, and the generic
 * Moonraker normalisation stays untouched.
 *
 * Every tool identity is always reported. A field the printer did not expose is
 * `null` (unknown), never a guessed default.
 */
export const SNAPMAKER_U1_TOOL_COUNT = 4

const TOOL_NAMES = ['T0', 'T1', 'T2', 'T3'] as const
const SENSOR_KINDS = [
  'filament_switch_sensor',
  'filament_motion_sensor',
] as const
/**
 * Filament sensor names that identify a tool. Only these shapes are mapped;
 * the naming used by the U1 firmware is not verified, so anything else stays
 * unknown rather than being matched by guesswork.
 */
const SENSOR_NAME = /^(?:e([0-3])_filament|filament_(?:sensor_)?([0-3]))$/

export type SnapmakerU1Tool = Readonly<{
  index: 0 | 1 | 2 | 3
  tool: (typeof TOOL_NAMES)[number]
  /** Klipper object that carries this tool's heater. */
  object: (typeof U1_TOOL_OBJECTS)[number]
  /** Whether Moonraker listed or reported the tool's heater at all. */
  reported: boolean
  /** null: the printer did not say which tool is active. */
  active: boolean | null
  celsius: number | null
  targetCelsius: number | null
  /** null: no filament sensor was mapped to this tool, or it reported no state. */
  filamentDetected: boolean | null
}>

export type SnapmakerU1Tools = Readonly<{
  model: 'snapmaker-u1'
  /** Always four entries, T0 to T3. */
  tools: readonly SnapmakerU1Tool[]
  activeTool: (typeof TOOL_NAMES)[number] | null
}>

/** Accepts the model strings a user or catalogue gives: "Snapmaker U1", "snapmaker-u1", "U1". */
export function isSnapmakerU1Model(model: string | null | undefined): boolean {
  if (typeof model !== 'string' || model.length > 128) return false
  return /^(?:snapmaker[\s_-]*)?u1$/i.test(model.trim())
}

const Filament = z
  .object({ filament_detected: z.boolean().optional().catch(undefined) })
  .passthrough()

function filamentByTool(
  status: Record<string, unknown>,
): Map<number, boolean | null> {
  const found = new Map<number, boolean | null>()
  for (const key of Object.keys(status)) {
    const space = key.indexOf(' ')
    if (space < 0) continue
    if (!(SENSOR_KINDS as readonly string[]).includes(key.slice(0, space)))
      continue
    const match = SENSOR_NAME.exec(key.slice(space + 1))
    const digit = match?.[1] ?? match?.[2]
    if (digit === undefined) continue
    const parsed = Filament.safeParse(status[key])
    found.set(
      Number(digit),
      parsed.success ? (parsed.data.filament_detected ?? null) : null,
    )
  }
  return found
}

/**
 * Projects a Moonraker `printer.objects.query` status onto the U1's four tools.
 * `objects` is the optional `printer.objects.list`; when given it only decides
 * `reported` for tools the status did not mention.
 */
export function mapSnapmakerU1Tools(
  status: unknown,
  objects: readonly string[] = [],
): SnapmakerU1Tools {
  const parsed = parseToolStatus(status)
  const byObject = new Map(parsed.tools.map((tool) => [tool.object, tool]))
  const filament = filamentByTool(status as Record<string, unknown>)
  const activeKnown =
    parsed.activeObject !== null &&
    (U1_TOOL_OBJECTS as readonly string[]).includes(parsed.activeObject)
  const tools = U1_TOOL_OBJECTS.map((object, index): SnapmakerU1Tool => {
    const seen = byObject.get(object)
    return {
      index: index as SnapmakerU1Tool['index'],
      tool: TOOL_NAMES[index]!,
      object,
      reported: seen !== undefined || objects.includes(object),
      active: activeKnown ? parsed.activeObject === object : null,
      celsius: seen?.celsius ?? null,
      targetCelsius: seen?.targetCelsius ?? null,
      filamentDetected: filament.get(index) ?? null,
    }
  })
  const active = tools.find((tool) => tool.active === true)
  return { model: 'snapmaker-u1', tools, activeTool: active?.tool ?? null }
}

/**
 * Locally declared Snapmaker U1 printers, by printer key. Only the Connector's
 * private collector configuration declares a model; nothing from the wire or
 * the browser can opt a printer in or out.
 */
const declaredU1 = new Map<string, number>()

/** Declares the configured U1 printers; the returned function withdraws them. */
export function declareSnapmakerU1Printers(
  printers: readonly Readonly<{
    printerKey: string
    model?: string | undefined
  }>[],
): () => void {
  const keys = printers
    .filter((printer) => isSnapmakerU1Model(printer.model))
    .map((printer) => printer.printerKey)
  for (const key of keys) declaredU1.set(key, (declaredU1.get(key) ?? 0) + 1)
  let withdrawn = false
  return () => {
    if (withdrawn) return
    withdrawn = true
    for (const key of keys) {
      const count = (declaredU1.get(key) ?? 1) - 1
      if (count > 0) declaredU1.set(key, count)
      else declaredU1.delete(key)
    }
  }
}

export function isDeclaredSnapmakerU1(printerKey: string): boolean {
  return declaredU1.has(printerKey)
}

/** Objects a U1 subscription adds: every tool heater and the active tool. */
export const SNAPMAKER_U1_STATUS_OBJECTS: Readonly<Record<string, string[]>> =
  Object.freeze({
    ...Object.fromEntries(
      U1_TOOL_OBJECTS.map((object) => [object, ['temperature', 'target']]),
    ),
    toolhead: ['extruder'],
  })

/** Whether a status object belongs to the U1 tool projection. */
export function isSnapmakerU1StatusObject(name: string): boolean {
  return Object.hasOwn(SNAPMAKER_U1_STATUS_OBJECTS, name)
}
