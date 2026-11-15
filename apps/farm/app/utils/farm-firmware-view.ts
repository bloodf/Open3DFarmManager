export interface FirmwareStatus {
  current?: string
  latest?: string
  updateAvailable?: boolean
  components?: { name: string; current: string; latest?: string }[]
}

export function firmwareView(
  firmware?: FirmwareStatus,
  identityFirmware?: string | null,
) {
  return {
    current:
      firmware?.current?.trim() ||
      identityFirmware?.trim() ||
      'não identificado',
    latest: firmware?.latest?.trim() || undefined,
    updateAvailable: firmware?.updateAvailable === true,
    components: firmware?.components ?? [],
  }
}
