import { z } from 'zod'
import { isWellFormedJsonString } from '../../../farm-protocol/src/string-bounds.ts'
import {
  MACRO_PARAM_MAX_KEYS,
  MacroName,
  MacroParamName,
  MacroParams,
  MacroParamValue,
} from '../../../farm-protocol/src/control-actions.ts'

/** One parameter a macro reads, with its literal default when it has one. */
export type MacroParamSpec = {
  readonly name: string
  readonly default?: string
}
export type MacroParamMap = Readonly<Record<string, readonly MacroParamSpec[]>>

const MAX_MACROS = 50
const SECTION = 'gcode_macro '

const Probe = z.object({
  status: z.object({
    configfile: z.object({
      config: z.record(z.string(), z.record(z.string(), z.unknown())),
    }),
  }),
})

// `params.X`, `params['X']`, optionally followed by `|default(literal)`.
const USE =
  /\bparams(?:\.([A-Za-z][A-Za-z0-9_]*)|\[\s*(?:'([^']*)'|"([^"]*)")\s*\])(?:\s*\|\s*default\s*\(\s*([^()|]*?)\s*[,)])?/g
const LITERAL = /^(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?))$/

/** Parameters one macro body reads; first default seen for a name wins. */
export function parseMacroParams(gcode: string): MacroParamSpec[] {
  const found = new Map<string, string | undefined>()
  for (const match of gcode.matchAll(USE)) {
    const name = match[1] ?? match[2] ?? match[3] ?? ''
    if (!MacroParamName.safeParse(name).success) continue
    const literal = match[4] === undefined ? undefined : LITERAL.exec(match[4])
    const value = literal?.[1] ?? literal?.[2] ?? literal?.[3]
    const usable =
      value !== undefined &&
      MacroParamValue.safeParse(value).success &&
      isWellFormedJsonString(value)
        ? value
        : undefined
    if (!found.has(name) || (found.get(name) === undefined && usable))
      found.set(name, usable)
  }
  return [...found]
    .slice(0, MACRO_PARAM_MAX_KEYS)
    .map(([name, value]) =>
      value === undefined ? { name } : { name, default: value },
    )
}

/**
 * Parameters of every advertised macro, from a configfile query result.
 * `_`-prefixed (private) macros are never listed. A missing or malformed
 * result yields an empty map: unknown parameters are never guessed.
 */
export function readMacroParams(
  result: unknown,
  macros: readonly string[],
): MacroParamMap {
  const probe = Probe.safeParse(result)
  if (!probe.success) return Object.freeze({})
  const sections = new Map(
    Object.entries(probe.data.status.configfile.config).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  )
  const map: Record<string, readonly MacroParamSpec[]> = Object.create(null)
  for (const name of macros.slice(0, MAX_MACROS)) {
    if (name.startsWith('_') || !MacroName.safeParse(name).success) continue
    const gcode = sections.get(`${SECTION}${name}`.toLowerCase())?.gcode
    const params = typeof gcode === 'string' ? parseMacroParams(gcode) : []
    if (params.length) map[name] = Object.freeze(params)
  }
  return Object.freeze({ ...map })
}

/**
 * True when every key is a parameter the macro declares. A macro with no
 * detected parameters accepts none, so an undetected config never widens a run.
 */
export function macroParamsAllowed(
  declared: MacroParamMap | undefined,
  name: string,
  params: unknown,
): boolean {
  if (params === undefined) return true
  const parsed = MacroParams.safeParse(params)
  if (!parsed.success) return false
  const known = new Set(declared?.[name]?.map((spec) => spec.name))
  return Object.keys(parsed.data).every((key) => known.has(key))
}

/** `NAME KEY=value ...` from validated parts only; throws on any unsafe input. */
export function buildMacroScript(name: unknown, params?: unknown): string {
  const parsedName = MacroName.parse(name)
  if (params === undefined) return parsedName
  const parsed = MacroParams.parse(params)
  return [
    parsedName,
    ...Object.keys(parsed)
      .sort()
      .map((key) => `${key}=${parsed[key]}`),
  ].join(' ')
}
