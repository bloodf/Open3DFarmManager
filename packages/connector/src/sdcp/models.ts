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
}>

const resin: SdcpProfile = Object.freeze({
  family: 'resin',
  uploadPort: 3030,
  from: 0,
  timestampMs: false,
  extensions: Object.freeze(['.ctb', '.goo']),
})
const carbon: SdcpProfile = Object.freeze({
  family: 'fdm',
  uploadPort: 80,
  from: 1,
  timestampMs: true,
  extensions: Object.freeze(['.gcode']),
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

export const RESIN_LIBRARY_START_MESSAGE =
  'Para iniciar uma impressão de resina, selecione uma versão validada do arquivo na biblioteca.'

export function sdcpStartUnavailableMessage(model: string, firmware?: string) {
  return firmware
    ? `O início de impressão na impressora ${model} com firmware ${firmware} ainda não foi qualificado.`
    : `O início de impressão na impressora ${model} exige uma versão de firmware qualificada.`
}
