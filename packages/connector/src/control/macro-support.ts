import { MacroName } from '../../../farm-protocol/src/control-actions.ts'

/** Only public, command-safe macros are advertised, in deterministic order. */
export function advertisedMoonrakerMacros(
  objects: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!objects) return undefined
  return Object.freeze(
    [
      ...new Set(
        objects
          .filter((object) => object.startsWith('gcode_macro '))
          .map((object) => object.slice('gcode_macro '.length))
          .filter(
            (name) =>
              MacroName.safeParse(name).success &&
              !['LOAD_FILAMENT', 'UNLOAD_FILAMENT'].includes(
                name.toUpperCase(),
              ),
          ),
      ),
    ]
      .sort()
      .slice(0, 50),
  )
}
