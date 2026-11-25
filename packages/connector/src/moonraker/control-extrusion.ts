import { DriverRefusalError } from '../control/driver-refusal.ts'
import { z } from 'zod'
import { ExtrudeArguments } from '../../../farm-protocol/src/control-actions.ts'

/** Highest extruder temperature the Connector accepts for an extrusion. */
export const EXTRUDE_MAX_TEMPERATURE_C = 300
const MAX_TOOLS = 16
const STATE_NAME = 'OPENFARM_EXTRUDE'

export type ExtrudeRefusalReason =
  'state' | 'unsupported-action' | 'invalid-command'

/**
 * Thrown before any write. The dispatcher reads `refusal` and reports a
 * not-sent result with that reason instead of an unknown outcome.
 */
export class ExtrudeRefused extends DriverRefusalError {
  constructor(refusal: ExtrudeRefusalReason) {
    super(refusal, `Extrusion refused: ${refusal}`)
  }
}

/** Klipper section of a tool; only tools the printer lists exist. */
export function extruderName(
  tool: number,
  objects: readonly string[],
): string | undefined {
  if (!Number.isInteger(tool) || tool < 0 || tool >= MAX_TOOLS) return undefined
  const name = tool === 0 ? 'extruder' : `extruder${tool}`
  return objects.includes(name) ? name : undefined
}

const number = (value: number) => String(Number(value.toFixed(3)))

/**
 * One G-code script for the whole request: select the tool, relative extrusion
 * (M83) and a single move, with the previous G-code state restored after it.
 * Built only from validated numbers and a listed object name.
 */
export function parseExtrude(
  args: unknown,
  objects: readonly string[],
): { name: string; script: string } {
  const parsed = ExtrudeArguments.safeParse(args)
  if (!parsed.success) throw new ExtrudeRefused('invalid-command')
  const { tool, length_mm, feed } = parsed.data
  const name = extruderName(tool, objects)
  if (!name) throw new ExtrudeRefused('unsupported-action')
  const select = objects.includes(`gcode_macro T${tool}`)
    ? `T${tool}`
    : `ACTIVATE_EXTRUDER EXTRUDER=${name}`
  return {
    name,
    script: [
      select,
      `SAVE_GCODE_STATE NAME=${STATE_NAME}`,
      'M83',
      `G1 E${number(length_mm)} F${Math.round(feed)}`,
      `RESTORE_GCODE_STATE NAME=${STATE_NAME}`,
    ].join('\n'),
  }
}

const Probe = z.object({
  status: z.record(
    z.string(),
    z.object({ temperature: z.number().finite(), can_extrude: z.boolean() }),
  ),
})

/** Read-only query of the live tool temperature and Klipper's own cold check. */
export const extrudeProbeWire = (id: number, name: string) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'printer.objects.query',
    params: { objects: { [name]: ['temperature', 'can_extrude'] } },
  })

/**
 * Refuses a cold tool. `can_extrude` is Klipper's comparison against the
 * configured `min_extrude_temp`; a missing or malformed reading refuses too.
 */
export function checkExtrudeProbe(result: unknown, name: string): void {
  const probe = Probe.safeParse(result)
  const tool = probe.success ? probe.data.status[name] : undefined
  if (
    !tool ||
    !tool.can_extrude ||
    tool.temperature > EXTRUDE_MAX_TEMPERATURE_C
  )
    throw new ExtrudeRefused('state')
}
