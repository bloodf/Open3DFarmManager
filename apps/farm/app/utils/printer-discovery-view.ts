import type { DiscoveryResult } from '../../../../packages/farm-protocol/src/configuration-discovery.ts'

type Printer = Extract<DiscoveryResult, { ok: true }>['printers'][number]
export function discoveryPrefill(printer: Printer) {
  return printer.vendor === 'bambu'
    ? {
        family: 'bambu-lan' as const,
        ip: printer.host,
        serial: printer.serial ?? '',
        label: printer.name ?? '',
      }
    : {
        family: 'klipper-moonraker' as const,
        origin: `http://${printer.host}${printer.port ? `:${printer.port}` : ''}`,
        label: printer.name ?? '',
      }
}
export function discoveryStatus(result: DiscoveryResult): string {
  if (!result.ok)
    return 'Não foi possível procurar impressoras. Tente novamente.'
  return result.printers.length
    ? `${result.printers.length} impressora(s) encontrada(s).`
    : 'Nenhuma impressora encontrada.'
}
