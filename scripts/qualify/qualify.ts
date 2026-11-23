// SPDX-License-Identifier: MIT
import { loadCredentials } from './credentials.ts'
import { evaluateCatalogPromotion } from './catalog.ts'
import { qualifyMoonraker } from './moonraker.ts'
import { qualifyBambu } from './bambu.ts'
import { qualifyCreality } from './creality.ts'
import { qualifyAnycubic } from './anycubic.ts'
import { qualifyKobraX } from './kobra-x.ts'
import type { QualifyCliOptions, QualificationReport } from './types.ts'

export async function qualifyPrinter(
  options: QualifyCliOptions,
): Promise<QualificationReport> {
  const rawVendor = options.vendor.trim().toLowerCase()
  const host = options.host.trim()
  const port = options.port ?? defaultPortForVendor(rawVendor)
  const credentials = loadCredentials(options.credentialFile)

  let qualificationResult: {
    identity: import('./types.ts').ObservedIdentity
    telemetry: import('./types.ts').ObservedTelemetry
    camera: import('./types.ts').ObservedCamera
    files: import('./types.ts').ObservedFiles
  }

  switch (rawVendor) {
    case 'moonraker':
    case 'klipper':
      qualificationResult = await qualifyMoonraker(
        { ...options, port },
        credentials,
      )
      break
    case 'bambu':
    case 'bambulab':
      qualificationResult = await qualifyBambu(
        { ...options, port },
        credentials,
      )
      break
    case 'creality':
      qualificationResult = await qualifyCreality(
        { ...options, port },
        credentials,
      )
      break
    case 'anycubic':
    case 'kobralink':
      qualificationResult = await qualifyAnycubic(
        { ...options, port },
        credentials,
      )
      break
    case 'kobra-x':
      qualificationResult = await qualifyKobraX(
        { ...options, port },
        credentials,
      )
      break
    default:
      throw new Error(
        `Unsupported printer vendor '${options.vendor}'. Supported vendors: moonraker, bambu, creality, anycubic, kobralink, kobra-x.`,
      )
  }

  const { identity, telemetry, camera, files } = qualificationResult

  const catalog = evaluateCatalogPromotion(
    identity,
    telemetry,
    camera,
    files,
    options.vendor,
  )

  let status: 'qualified' | 'partially_qualified' | 'unreachable' =
    'unreachable'
  let summary = ''

  if (telemetry.observed && (camera.reachable || files.listable)) {
    status = 'qualified'
    summary = `Printer successfully qualified with active telemetry (${telemetry.fields.length} fields) and ${[camera.reachable ? 'camera' : '', files.listable ? 'files' : ''].filter(Boolean).join(' + ')} verified.`
  } else if (telemetry.observed) {
    status = 'partially_qualified'
    summary = `Telemetry observed with ${telemetry.fields.length} field(s), but camera and files could not be verified.`
  } else {
    status = 'unreachable'
    summary =
      telemetry.reason ??
      'No telemetry or status response received from printer.'
  }

  return {
    vendor: rawVendor,
    host,
    port,
    timestamp: new Date().toISOString(),
    identity,
    telemetry,
    camera,
    files,
    catalog,
    qualification: {
      status,
      summary,
    },
  }
}

function defaultPortForVendor(vendor: string): number {
  switch (vendor) {
    case 'moonraker':
    case 'klipper':
      return 7125
    case 'bambu':
    case 'bambulab':
      return 8883
    case 'creality':
      return 9999
    case 'anycubic':
      return 9883
    case 'kobralink':
      return 18910
    case 'kobra-x':
      return 9883
    default:
      return 80
  }
}
