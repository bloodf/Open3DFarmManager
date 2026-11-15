// The LAN command reference does not document ACE feed or unload requests:
// https://github.com/rvanderp3/kobra-connect/blob/main/docs/mqtt-commands.md
export function buildAnycubicFilamentCommand(
  _action: 'load_filament' | 'unload_filament',
  _slot: number,
): never {
  throw new Error('Anycubic ACE filament commands are unsupported')
}
