export type BambuCloudPrinterDiscovery = {
  serial: string
  name: string
  model: string
  nozzle: number
}

export type BambuCloudPrintersResponse = {
  printers: BambuCloudPrinterDiscovery[]
  skippedMalformed: number
}

export type BambuSetupPrefillTarget = {
  onboardingFamily: { value: string }
  bambuSerial: { value: string }
  kobraLabel: { value: string }
}

/** Prefills the Bambu LAN setup fields from a cloud discovery row. */
export function prefillBambuSetupFromCloudPrinter(
  printer: BambuCloudPrinterDiscovery,
  target: BambuSetupPrefillTarget,
) {
  target.onboardingFamily.value = 'bambu-lan'
  target.bambuSerial.value = printer.serial
  target.kobraLabel.value = printer.name
}

export function bambuCloudPrinterLabel(printer: BambuCloudPrinterDiscovery) {
  return `${printer.name} · ${printer.model} · bico ${printer.nozzle} mm · ${printer.serial}`
}

export async function fetchBambuCloudPrinters(
  farmId: string,
  knownSerials: readonly string[] = [],
): Promise<BambuCloudPrintersResponse> {
  const query =
    knownSerials.length > 0
      ? { knownSerials: knownSerials.join(',') }
      : undefined
  return await $fetch<BambuCloudPrintersResponse>(
    `/api/farms/${farmId}/bambu-cloud/printers`,
    {
      ...(query ? { query } : {}),
      retry: 0,
      timeout: 15_000,
    },
  )
}
