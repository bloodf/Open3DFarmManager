// Every printer write stays off until the owner qualifies the exact model and
// firmware for it, like the SDCP start list. Evidence and gaps:
// docs/fullfarmmanager/evidence/anycubic-resin.md

/** The writes the Connector can reach: job stop and camera start/stop. */
export type PhotonResinWrite = 'print-stop' | 'camera'

/**
 * No cited P1 Max exchange reports the installed firmware, so the only value a
 * session can present is this one. Listing it qualifies a printer whose
 * firmware the Connector cannot check.
 */
export const PHOTON_RESIN_UNREPORTED_FIRMWARE = 'unreported'

export type PhotonResinQualification = Readonly<{
  operation: PhotonResinWrite
  model: string
  firmwareVersion: string
}>

/** Empty on purpose. Neither the wire nor the runtime file can add an entry. */
export const PHOTON_RESIN_QUALIFIED_WRITES: readonly PhotonResinQualification[] =
  Object.freeze([])

export function photonResinWriteQualified(
  operation: PhotonResinWrite,
  model: string,
  qualified: readonly PhotonResinQualification[] = PHOTON_RESIN_QUALIFIED_WRITES,
): boolean {
  return qualified.some(
    (entry) =>
      entry.operation === operation &&
      entry.model === model &&
      entry.firmwareVersion === PHOTON_RESIN_UNREPORTED_FIRMWARE,
  )
}
