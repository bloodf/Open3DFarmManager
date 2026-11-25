/**
 * Elegoo models with documented SDCP print control and upload. Anything not
 * listed here stays read-only or unsupported; see
 * docs/fullfarmmanager/evidence/elegoo.md for the per-model reasons.
 *
 * Sources (wire facts only; no vendor implementation copied):
 * - cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215,
 *   "SDCP(Smart Device Control Protocol)_V3.0.0_EN.md" (resin boards).
 * - alfiedennen/sdcp-saturn-4-ultra @ d253519, README.md (Saturn 4 Ultra 16K,
 *   firmware V1.5.6).
 * - ELEGOO-3D/elegoo-link @ ec2d226,
 *   src/lan/adapters/elegoo_fdm_cc/ (Centauri Carbon).
 * - bjan/pycentauri @ 2f6d9ed, docs/PROTOCOL.md (Centauri Carbon, V1.1.46).
 */
export type SdcpFamily = 'resin' | 'fdm'

export type SdcpProfile = Readonly<{
  family: SdcpFamily
  /** HTTP port of `/uploadFile/upload`: 3030 in the spec, 80 on the Carbon. */
  uploadPort: number
  /** `From` field: the spec's local client is 0, elegoo-link sends 1. */
  from: 0 | 1
  /** `TimeStamp` unit: seconds in the spec, milliseconds on the Carbon. */
  timestampMs: boolean
  /** Printable file types the upload and start accept. */
  extensions: readonly string[]
  /** Cmd 320/321 print history as the CBD spec documents it. */
  history: boolean
  /** Cmd 386 video stream (RTSP) as the CBD spec documents it. */
  camera: boolean
}>

const resin: SdcpProfile = Object.freeze({
  family: 'resin',
  uploadPort: 3030,
  from: 0,
  timestampMs: false,
  extensions: Object.freeze(['.ctb', '.goo']),
  history: true,
  camera: true,
})
const carbon: SdcpProfile = Object.freeze({
  family: 'fdm',
  uploadPort: 80,
  from: 1,
  timestampMs: true,
  extensions: Object.freeze(['.gcode']),
  // The CBD spec is written for resin boards. On the Carbon, pycentauri
  // lists Cmd 386 as untested and saw 320/321 only on OpenCentauri firmware,
  // and an unexpected command can crash the firmware: neither is sent.
  history: false,
  camera: false,
})

const profiles = new Map<string, SdcpProfile>([
  ['saturn 4 ultra', resin],
  ['saturn 4 ultra 16k', resin],
  ['mars 5 ultra', resin],
  // Exact name only: the Centauri Carbon 2 speaks MQTT, not SDCP.
  ['centauri carbon', carbon],
])

export const sdcpModelKey = (model: string) =>
  model.replace(/^elegoo\s+/i, '').toLowerCase()

export function sdcpProfile(model: string): SdcpProfile | undefined {
  return profiles.get(sdcpModelKey(model))
}

export const SDCP_CONTROL_ACTIONS = Object.freeze([
  'pause',
  'resume',
  'cancel',
  'start_print',
] as const)
export type SdcpAction = (typeof SDCP_CONTROL_ACTIONS)[number]

/** One exact model and firmware pair. */
export type SdcpQualification = Readonly<{
  model: string
  firmwareVersion: string
}>

/**
 * Pairs whose start (Cmd 128) passed a supervised run on hardware. Cmd 128 is
 * reported to crash first-generation Centauri Carbon and resin firmware, so
 * every other pair is neither offered nor sent a start. Add a pair only with
 * that run recorded in docs/fullfarmmanager/evidence/elegoo.md.
 */
export const SDCP_QUALIFIED_STARTS: readonly SdcpQualification[] =
  Object.freeze([])

export function sdcpStartQualified(
  model: string,
  firmwareVersion: string,
  qualified: readonly SdcpQualification[] = SDCP_QUALIFIED_STARTS,
): boolean {
  return qualified.some(
    (pair) =>
      sdcpModelKey(pair.model) === sdcpModelKey(model) &&
      pair.firmwareVersion === firmwareVersion,
  )
}

/**
 * Pairs allowed to receive the video stream write (Cmd 386), which only the
 * signed `power` command sends. Empty: no printer is offered the command or a
 * camera. Add a pair only with a supervised run on hardware recorded in
 * docs/fullfarmmanager/evidence/elegoo.md.
 */
export const SDCP_QUALIFIED_VIDEO: readonly SdcpQualification[] = Object.freeze(
  [],
)

export function sdcpVideoQualified(
  model: string,
  firmwareVersion: string,
  qualified: readonly SdcpQualification[] = SDCP_QUALIFIED_VIDEO,
): boolean {
  return (
    sdcpProfile(model)?.camera === true &&
    sdcpStartQualified(model, firmwareVersion, qualified)
  )
}

/** Whether any pair of this model is listed; otherwise nothing is offered. */
export function sdcpVideoOffered(
  model: string,
  qualified: readonly SdcpQualification[] = SDCP_QUALIFIED_VIDEO,
): boolean {
  return (
    sdcpProfile(model)?.camera === true &&
    qualified.some((pair) => sdcpModelKey(pair.model) === sdcpModelKey(model))
  )
}

export const RESIN_LIBRARY_START_MESSAGE =
  'Para iniciar uma impressão de resina, selecione uma versão validada do arquivo na biblioteca.'

export function sdcpStartUnavailableMessage(model: string, firmware?: string) {
  return firmware
    ? `O início de impressão na impressora ${model} com firmware ${firmware} ainda não foi qualificado.`
    : `O início de impressão na impressora ${model} exige uma versão de firmware qualificada.`
}
