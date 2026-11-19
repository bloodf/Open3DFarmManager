import {
  OutputName,
  SetLedArguments,
  SetPinArguments,
} from '../../../farm-protocol/src/control-actions.ts'

export type OutputRefusalReason = 'unsupported-action' | 'invalid-command'

/**
 * Thrown before any write. The dispatcher reads `refusal` and reports a
 * not-sent result with that reason instead of an unknown outcome.
 */
export class OutputRefused extends Error {
  readonly refusal: OutputRefusalReason
  constructor(refusal: OutputRefusalReason) {
    super(`Output refused: ${refusal}`)
    this.refusal = refusal
  }
}

const FAN_TYPES = ['fan_generic', 'controller_fan'] as const
const LED_TYPES = ['led', 'neopixel', 'dotstar'] as const

/** Names the printer lists for the given Klipper section types, sorted. */
function listed(
  objects: readonly string[],
  types: readonly string[],
): string[] {
  return objects
    .flatMap((object) => {
      const space = object.indexOf(' ')
      if (space < 0 || !types.includes(object.slice(0, space))) return []
      const name = object.slice(space + 1)
      return OutputName.safeParse(name).success ? [name] : []
    })
    .sort()
}

export const fanNames = (objects: readonly string[]) =>
  listed(objects, FAN_TYPES)
export const ledNames = (objects: readonly string[]) =>
  listed(objects, LED_TYPES)
export const pinNames = (objects: readonly string[]) =>
  listed(objects, ['output_pin'])

/** A name outside the printer's object list never reaches a G-code script. */
function known(names: readonly string[], name: string): string {
  if (!names.includes(name)) throw new OutputRefused('unsupported-action')
  return name
}

const fraction = (value: number) => String(Number(value.toFixed(3)))
const channel = (value: number) => fraction(value / 255)

/** SET_FAN_SPEED for a named fan_generic or controller_fan; speed is 0-255. */
export function namedFanScript(
  fan: string,
  speed255: number,
  objects: readonly string[],
): string {
  if (!OutputName.safeParse(fan).success)
    throw new OutputRefused('invalid-command')
  return `SET_FAN_SPEED FAN=${known(fanNames(objects), fan)} SPEED=${Number((speed255 / 255).toFixed(2))}`
}

/** SET_LED with 0-255 channels; SYNC=0 so a print is not stalled. */
export function ledScript(args: unknown, objects: readonly string[]): string {
  const parsed = SetLedArguments.safeParse(args)
  if (!parsed.success) throw new OutputRefused('invalid-command')
  const { name, r, g, b, w } = parsed.data
  const white = w === undefined ? '' : ` WHITE=${channel(w)}`
  return `SET_LED LED=${known(ledNames(objects), name)} RED=${channel(r)} GREEN=${channel(g)} BLUE=${channel(b)}${white} TRANSMIT=1 SYNC=0`
}

/** SET_PIN for a listed output_pin; value is 0..1 (digital pins take 0 or 1). */
export function pinScript(args: unknown, objects: readonly string[]): string {
  const parsed = SetPinArguments.safeParse(args)
  if (!parsed.success) throw new OutputRefused('invalid-command')
  const { name, value } = parsed.data
  return `SET_PIN PIN=${known(pinNames(objects), name)} VALUE=${fraction(value)}`
}
