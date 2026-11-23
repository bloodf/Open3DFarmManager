// SPDX-License-Identifier: MIT
import {
  GCODE_LINE_MAX_BYTES,
  GcodeLine,
} from '../../../../../packages/farm-protocol/src/control-actions.ts'

/** Lines kept on screen; the oldest are dropped first. */
export const CONSOLE_SCROLLBACK_LINES = 1000
/** Commands remembered per browser and printer. */
export const CONSOLE_HISTORY_MAX = 100
export const CONSOLE_SUGGESTION_MAX = 8

export type ConsoleEntry = Readonly<{
  id: number
  kind: 'command' | 'response'
  text: string
}>

/** Appends lines and keeps only the newest `CONSOLE_SCROLLBACK_LINES`. */
export function appendEntries(
  entries: readonly ConsoleEntry[],
  kind: ConsoleEntry['kind'],
  texts: readonly string[],
): ConsoleEntry[] {
  let id = entries.length ? entries[entries.length - 1]!.id + 1 : 1
  const added = texts.map((text) => ({ id: id++, kind, text }))
  return [...entries, ...added].slice(-CONSOLE_SCROLLBACK_LINES)
}

// "ok T:200.0 /210.0 B:60.0 /60.0", "T:25.1 /0.0", "B:24.9 /0.0 @:0".
const TEMPERATURE = /(?:^|\s)[TB]\d*:\s*-?\d+(?:\.\d+)?\s*\/\s*-?\d/
export const isTemperatureChatter = (text: string) => TEMPERATURE.test(text)

/** Commands you typed always stay; only temperature responses are filtered. */
export function visibleEntries(
  entries: readonly ConsoleEntry[],
  hideTemperature: boolean,
): ConsoleEntry[] {
  return hideTemperature
    ? entries.filter(
        (entry) =>
          entry.kind === 'command' || !isTemperatureChatter(entry.text),
      )
    : [...entries]
}

/** Why a line cannot be sent, in pt-BR; undefined when it can. */
export function lineProblem(line: string): string | undefined {
  if (!line.trim()) return 'Digite um comando.'
  return GcodeLine.safeParse(line).success
    ? undefined
    : `Use uma única linha de até ${GCODE_LINE_MAX_BYTES} caracteres ASCII imprimíveis.`
}

/** Newest last, no consecutive duplicates, bounded. */
export function pushHistory(
  history: readonly string[],
  line: string,
): string[] {
  if (history[history.length - 1] === line) return [...history]
  return [...history, line].slice(-CONSOLE_HISTORY_MAX)
}

/**
 * Arrow-key navigation. The cursor is an index into the history; one past the
 * end is the empty, fresh line.
 */
export function stepHistory(
  history: readonly string[],
  cursor: number,
  direction: 'up' | 'down',
): { cursor: number; text: string } {
  const next =
    direction === 'up'
      ? Math.max(0, Math.min(cursor, history.length) - 1)
      : Math.min(history.length, cursor + 1)
  return { cursor: next, text: history[next] ?? '' }
}

/** Command names that start with what was typed, first word only. */
export function suggestCommands(
  input: string,
  commands: readonly string[],
): string[] {
  const typed = input.trim().toUpperCase()
  if (!typed || /\s/.test(input.trim())) return []
  return commands
    .filter(
      (name) =>
        name.toUpperCase().startsWith(typed) && name.toUpperCase() !== typed,
    )
    .slice(0, CONSOLE_SUGGESTION_MAX)
}

/** Tab completion: the first suggestion, then a space for its parameters. */
export const completeCommand = (suggestions: readonly string[]) =>
  suggestions.length ? `${suggestions[0]} ` : undefined

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
const historyKey = (printerKey: string) =>
  `openfarm.console.history.${printerKey}`

/** Reads this browser's history; a missing or damaged store yields none. */
export function loadHistory(
  storage: Storage | undefined,
  printerKey: string,
): string[] {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(historyKey(printerKey)) ?? '[]',
    )
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (item): item is string =>
              typeof item === 'string' && GcodeLine.safeParse(item).success,
          )
          .slice(-CONSOLE_HISTORY_MAX)
      : []
  } catch {
    return []
  }
}

export function saveHistory(
  storage: Storage | undefined,
  printerKey: string,
  history: readonly string[],
): void {
  try {
    storage?.setItem(historyKey(printerKey), JSON.stringify(history))
  } catch {
    // Private windows and blocked storage only lose the convenience.
  }
}

/** What the Connector accepts while a job runs; shown as a hint, enforced there. */
export const PRINTING_ALLOW_LIST =
  'M220, M221, SET_GCODE_OFFSET Z_ADJUST, SET_FAN_SPEED, SET_LED, SET_PIN, M117, GET_POSITION, QUERY_*, M105, M114 e M115'
