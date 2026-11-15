import type { MoonrakerRpcCall } from './commands.ts'

const prefix = 'gcode_macro '
const safeName = /^[A-Za-z][A-Za-z0-9_]*$/
const filament = ['LOAD_FILAMENT', 'UNLOAD_FILAMENT']

function advertised(objects: readonly string[]): string[] {
  return objects
    .filter((object) => object.startsWith(prefix))
    .map((object) => object.slice(prefix.length))
    .filter((name) => safeName.test(name))
}

export function listMoonrakerMacros(objects: readonly string[]): string[] {
  return [
    ...new Set(
      advertised(objects).filter(
        (name) => !filament.includes(name.toUpperCase()),
      ),
    ),
  ]
    .sort()
    .slice(0, 50)
}

export function supportedMoonrakerFilamentActions(
  objects: readonly string[],
): string[] {
  const names = advertised(objects).map((name) => name.toUpperCase())
  return filament
    .filter((name) => names.includes(name))
    .map((name) => name.toLowerCase())
}

export function buildMoonrakerMacroCommand(
  action: string,
  args: Record<string, unknown>,
  objects: readonly string[],
): MoonrakerRpcCall {
  let name: unknown
  if (action === 'run_macro') {
    if (Object.keys(args).length !== 1 || !('name' in args))
      throw new Error('Invalid macro arguments')
    name = args.name
    if (
      typeof name !== 'string' ||
      !listMoonrakerMacros(objects).includes(name)
    )
      throw new Error('Macro not advertised')
  } else if (action === 'load_filament' || action === 'unload_filament') {
    if (Object.keys(args).length) throw new Error('Invalid filament arguments')
    name = advertised(objects).find(
      (item) => item.toUpperCase() === action.toUpperCase(),
    )
    if (!name) throw new Error('Filament macro not advertised')
  } else {
    throw new Error('Unsupported macro action')
  }
  return { method: 'printer.gcode.script', params: { script: name } }
}
