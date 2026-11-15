import type { CrealityTelemetry } from './index.ts'

/** Map the version carried by a stock Creality status frame. */
export function mapCrealityFirmware(
  status: CrealityTelemetry,
): { current: string } | undefined {
  const version = status.firmwareVersion
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    version.length > 64 ||
    /[\x00-\x1f\x7f-\x9f]/.test(version)
  )
    return undefined
  return { current: version }
}
