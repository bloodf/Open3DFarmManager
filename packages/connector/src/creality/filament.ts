/**
 * The documented stock LAN protocol does not specify filament operations.
 * https://github.com/ChestnutLabs/printer-protocol-orchard/blob/main/protocols/creality.md
 * Do not infer motion commands from status or vendor-specific interfaces.
 */
export function buildCrealityFilamentCommand(action: string): never {
  throw new Error(`Unsupported Creality filament action '${action}'`)
}
