import { MachineProfile } from '../../../farm-protocol/src/machine-profile.ts'

/**
 * Nozzle diameter from a Bambu `print` report (`nozzle_diameter`, a decimal
 * string or number). The report carries no bed, tool-count or limit fields,
 * and the model name is already in the printer identity: those stay unknown.
 */
export function parseBambuMachineProfile(
  report: unknown,
): MachineProfile | undefined {
  const print =
    report !== null && typeof report === 'object' && !Array.isArray(report)
      ? (report as Record<string, unknown>).print
      : undefined
  if (print === null || typeof print !== 'object' || Array.isArray(print))
    return undefined
  const raw = (print as Record<string, unknown>).nozzle_diameter
  const diameter =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d{1,2}(?:\.\d{1,3})?$/.test(raw)
        ? Number(raw)
        : undefined
  if (diameter === undefined) return undefined
  const parsed = MachineProfile.safeParse({ nozzleDiametersMm: [diameter] })
  return parsed.success ? parsed.data : undefined
}
