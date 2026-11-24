import { z } from 'zod'
import { GcodeLine } from '../../../farm-protocol/src/control-actions.ts'

/**
 * Moonraker adapter for the signed `gcode` console action. One validated line
 * is sent as one `printer.gcode.script`. Refusals are decided here, from one
 * state read taken just before the single send, and nothing is retried.
 * Responses reach the browser through `detail.gcode_response`, not here.
 */

export type ConsoleRefusalCode =
  | 'invalid'
  | 'disabled'
  | 'unsupported'
  | 'unknown-state'
  | 'not-allowed'
  | 'rate'
/**
 * The dispatcher reads `refusal` and reports a not-sent result with that
 * reason: a refusal wrote nothing, so it must never read as an unknown outcome.
 */
const DISPATCH_REASON: Readonly<
  Record<ConsoleRefusalCode, 'state' | 'unsupported-action' | 'invalid-command'>
> = {
  invalid: 'invalid-command',
  'not-allowed': 'invalid-command',
  disabled: 'unsupported-action',
  unsupported: 'unsupported-action',
  'unknown-state': 'state',
  rate: 'state',
}
export class ConsoleRefusal extends Error {
  readonly code: ConsoleRefusalCode
  readonly refusal: 'state' | 'unsupported-action' | 'invalid-command'
  constructor(code: ConsoleRefusalCode) {
    super(`Console refused: ${code}`)
    this.name = 'ConsoleRefusal'
    this.code = code
    this.refusal = DISPATCH_REASON[code]
  }
}

/** Per printer and minute; the documented console action-class ceiling. */
export const CONSOLE_RATE_PER_MINUTE = 10
const WINDOW_MS = 60_000

/** The console needs the printer's own G-code object; nothing is assumed. */
export function consoleSupported(objects: readonly string[] | undefined) {
  return !!objects?.includes('webhooks')
}

/** Commands the console never sends: restarts and saves have their own actions. */
const ALWAYS_REFUSED = new Set([
  'RESTART',
  'FIRMWARE_RESTART',
  'SAVE_CONFIG',
  'SDCARD_PRINT_FILE',
])

const SAFE_VALUE = /^[A-Za-z0-9_.+-]{1,64}$/
const NUMBER = /^-?\d{1,6}(?:\.\d{1,6})?$/
const KEY_VALUE = /^[A-Za-z_][A-Za-z0-9_]{0,31}=([^\s;#*"']+)$/

/** `WORD` and its parameter tokens; `;` comments and `*` checksums are refused. */
function tokens(line: string): string[] | undefined {
  if (!GcodeLine.safeParse(line).success) return undefined
  if (/[;*"']/.test(line)) return undefined
  return line.trim().split(/\s+/)
}

const keyValues = (
  params: readonly string[],
  allowed: (key: string, value: string) => boolean,
) =>
  params.length > 0 &&
  params.every((token) => {
    const match = KEY_VALUE.exec(token)
    return !!match && allowed(token.slice(0, token.indexOf('=')), match[1]!)
  })

/**
 * The mandatory allow-list while printing or paused. Commands are parsed and
 * every parameter checked; a matching prefix never authorizes anything.
 */
export function consoleAllowedWhilePrinting(line: string): boolean {
  const parts = tokens(line)
  if (!parts) return false
  const [word, ...params] = parts
  const command = word!.toUpperCase()
  switch (command) {
    case 'M220':
    case 'M221':
      return params.length === 1 && /^S\d{1,3}$/i.test(params[0]!)
    case 'M105':
    case 'M114':
    case 'M115':
    case 'GET_POSITION':
      return params.length === 0
    case 'M117':
      return true
    case 'SET_GCODE_OFFSET':
      return (
        keyValues(
          params,
          (key, value) =>
            key.toUpperCase() === 'Z_ADJUST' && NUMBER.test(value),
        ) && params.length === 1
      )
    case 'SET_FAN_SPEED':
    case 'SET_LED':
    case 'SET_PIN':
      return keyValues(params, (_key, value) => SAFE_VALUE.test(value))
    default:
      return (
        /^QUERY_[A-Z0-9_]{1,56}$/.test(command) &&
        (params.length === 0 ||
          keyValues(params, (_key, value) => SAFE_VALUE.test(value)))
      )
  }
}

/** Any line the console may send while the printer is stopped. */
export function consoleAllowedWhenStopped(
  line: string,
  additionalRefused?: readonly string[],
): boolean {
  const parts = tokens(line)
  if (!parts) return false
  const command = parts[0]!.toUpperCase()
  return !ALWAYS_REFUSED.has(command) && !additionalRefused?.includes(command)
}

const PrintState = z.enum([
  'standby',
  'printing',
  'paused',
  'error',
  'complete',
  'cancelled',
])
export const ConsoleSnapshot = z.strictObject({
  eventtime: z.number().finite().nonnegative(),
  status: z.strictObject({
    webhooks: z.strictObject({
      state: z.enum(['ready', 'startup', 'shutdown', 'error']),
    }),
    print_stats: z.strictObject({ state: PrintState }),
  }),
})
export type ConsoleState = Readonly<{
  ready: boolean
  printState: z.infer<typeof PrintState>
}>

export function consoleQueryWire(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'printer.objects.query',
    params: {
      objects: { webhooks: ['state'], print_stats: ['state'] },
    },
  })
}

/** Anything but a well-formed reply is "unknown state", which refuses. */
export function parseConsoleState(result: unknown): ConsoleState {
  const parsed = ConsoleSnapshot.safeParse(result)
  if (!parsed.success) throw new ConsoleRefusal('unknown-state')
  const { webhooks, print_stats } = parsed.data.status
  return Object.freeze({
    ready: webhooks.state === 'ready',
    printState: print_stats.state,
  })
}

/**
 * Throws a ConsoleRefusal unless the line may be sent in this state: any valid
 * line when stopped, the tuning allow-list while printing or paused.
 */
export function refuseConsole(
  args: Record<string, unknown>,
  state: ConsoleState | undefined,
  additionalRefused?: readonly string[],
): string {
  const parsed = z.strictObject({ line: GcodeLine }).safeParse(args)
  if (!parsed.success) throw new ConsoleRefusal('invalid')
  const { line } = parsed.data
  if (!state?.ready || state.printState === 'error')
    throw new ConsoleRefusal('unknown-state')
  const active =
    state.printState === 'printing' || state.printState === 'paused'
  if (
    !(active
      ? consoleAllowedWhilePrinting(line)
      : consoleAllowedWhenStopped(line, additionalRefused))
  )
    throw new ConsoleRefusal('not-allowed')
  return line
}

/** Wire call for one console line; throws on an unsafe line. */
export function buildConsoleScript(args: Record<string, unknown>): string {
  const parsed = z.strictObject({ line: GcodeLine }).safeParse(args)
  if (!parsed.success || !tokens(parsed.data.line))
    throw new ConsoleRefusal('invalid')
  return parsed.data.line.trim()
}

/** Accepted sends per binding, newest last. Fails closed on a bad clock. */
const accepted = new WeakMap<object, number[]>()
export function takeConsoleRate(binding: object, nowMs: number): void {
  if (!Number.isFinite(nowMs)) throw new ConsoleRefusal('rate')
  const recent = (accepted.get(binding) ?? []).filter(
    (at) => at <= nowMs && nowMs - at < WINDOW_MS,
  )
  if (recent.length >= CONSOLE_RATE_PER_MINUTE) {
    accepted.set(binding, recent)
    throw new ConsoleRefusal('rate')
  }
  accepted.set(binding, [...recent, nowMs])
}

const COMMAND_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const MAX_HELP_COMMANDS = 512

/**
 * Command names of a `printer.gcode.help` reply, for autocomplete only. The
 * descriptions are dropped and an unexpected reply yields no suggestions.
 */
export function parseGcodeHelp(result: unknown): string[] {
  if (typeof result !== 'object' || result === null || Array.isArray(result))
    return []
  return Object.keys(result)
    .filter((name) => COMMAND_NAME.test(name))
    .sort()
    .slice(0, MAX_HELP_COMMANDS)
}
