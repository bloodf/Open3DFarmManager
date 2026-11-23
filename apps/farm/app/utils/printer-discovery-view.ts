import type { DiscoveryResult } from '../../../../packages/farm-protocol/src/configuration-discovery.ts'

type Printer = Extract<DiscoveryResult, { ok: true }>['printers'][number]

export function discoveryLabel(printer: Printer): string {
  if (printer.name) return printer.name
  if (printer.model) return printer.model
  switch (printer.vendor) {
    case 'bambu':
      return 'Bambu Lab'
    case 'moonraker':
      return 'Moonraker'
    case 'creality':
      return 'Creality'
    case 'anycubic':
      return 'Anycubic'
    case 'kobra-x':
      return 'Anycubic Kobra X'
    case 'sdcp':
      return 'Elegoo SDCP'
    default: {
      const _exhaustive: never = printer.vendor
      return _exhaustive
    }
  }
}

export function discoveryPrefill(printer: Printer) {
  switch (printer.vendor) {
    case 'bambu':
      return {
        family: 'bambu-lan' as const,
        ip: printer.host,
        serial: printer.serial ?? '',
        label: printer.name ?? '',
      }
    case 'moonraker':
      return {
        family: 'klipper-moonraker' as const,
        origin: `http://${printer.host}${printer.port ? `:${printer.port}` : ''}`,
        label: printer.name ?? '',
      }
    case 'creality':
      return {
        family: 'creality-native' as const,
        host: printer.host,
        label: printer.name ?? '',
      }
    case 'anycubic':
      return {
        family: 'anycubic-lan' as const,
        host: printer.host,
        label: printer.name ?? '',
      }
    case 'sdcp':
      return null
    case 'kobra-x':
      return {
        family: 'anycubic-kobra-x' as const,
        ip: printer.host,
        label: printer.name ?? '',
      }
    default: {
      const _exhaustive: never = printer.vendor
      return _exhaustive
    }
  }
}
export function discoveryStatus(result: DiscoveryResult): string {
  if (!result.ok)
    return 'Não foi possível procurar impressoras. Tente novamente.'
  return result.printers.length
    ? `${result.printers.length} impressora(s) encontrada(s).`
    : 'Nenhuma impressora encontrada.'
}
