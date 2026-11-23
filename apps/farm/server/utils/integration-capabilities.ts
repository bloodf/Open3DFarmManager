import { createHash } from 'node:crypto'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import type { AnycubicCatalogProduct } from '../../app/utils/compatibility/anycubic.ts'
import { fleetCatalog } from '../../app/utils/compatibility/fleet-catalog.ts'
import { matchCatalogProduct } from '../../app/utils/compatibility/match.ts'
import {
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
  uuidPattern,
} from './integration-auth.ts'
import { integrationGrantFor } from './integration-auth-http.ts'

/**
 * Firmware strings recorded on hardware-qualified runs. Each value is
 * `identity.firmware` from the report cited by that catalog entry:
 * docs/hardware-reports/2026-11-21-sovol-sv06-moonraker.json,
 * docs/hardware-reports/2026-11-21-snapmaker-u1-moonraker.json,
 * docs/hardware-reports/2026-11-21-anycubic-kobra-x-native.json.
 * A simulator version is not in this set.
 */
export const qualifiedFirmwareByCatalogId: Readonly<
  Record<string, readonly string[]>
> = {
  'klipper-generic-moonraker': [
    'Moonraker v0.11.0-4-gb559b9a',
    'Moonraker 2.0.0',
  ],
  'anycubic-kobra-x': ['2.0.2.8'],
}

export type PrinterOperation =
  | 'supported-control'
  | 'monitoring-only'
  | 'unknown-firmware'
  | 'temporarily-unavailable'
  | 'unqualified'

export type PrinterDegradedReason =
  | 'offline'
  | 'reconnecting'
  | 'error'
  | 'unknown-state'
  | 'client-certificate-missing'

export interface PrinterQualification {
  operation: PrinterOperation
  catalogId: string | null
  evidenceRevision: string | null
}

const controlKeys = ['pause', 'resume', 'cancel'] as const

function compact(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

function fleetGrades(product: AnycubicCatalogProduct) {
  const brand = compact(product.brand)
  const model = compact(product.model)
  const entry = fleetCatalog.find(
    (item) => compact(item.brand) === brand && compact(item.model) === model,
  )
  return entry
    ? { grade: entry.grade, protocolGrade: entry.protocolGrade }
    : null
}

/** Revision of the evidence used to classify operations. Specs are not included. */
export function catalogEvidenceRevision(product: AnycubicCatalogProduct) {
  const { capabilities } = product
  const body = {
    id: product.id,
    capabilities: {
      telemetry: capabilities.telemetry,
      files: capabilities.files,
      camera: capabilities.camera,
      materials: capabilities.materials,
      pause: capabilities.pause,
      resume: capabilities.resume,
      cancel: capabilities.cancel,
    },
    hardwareReports: product.hardwareReports ?? null,
    sources: [...product.sources],
    fleet: fleetGrades(product),
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function printerDegradedReason(
  state: PrinterState,
): PrinterDegradedReason | null {
  if (state.statusReason === 'client-certificate-missing')
    return 'client-certificate-missing'
  const link = state.linkHealth?.state
  if (link !== undefined) {
    switch (link) {
      case 'reconnecting':
        return 'reconnecting'
      case 'offline':
        return 'offline'
      case 'connected':
        break
      default: {
        const unreachable: never = link
        return unreachable
      }
    }
  }
  switch (state.state) {
    case 'offline':
      return 'offline'
    case 'error':
      return 'error'
    case 'unknown':
      return 'unknown-state'
    case 'idle':
    case 'printing':
    case 'paused':
      return null
    default: {
      const unreachable: never = state.state
      return unreachable
    }
  }
}

function observedFirmware(state: PrinterState) {
  const firmware = state.identity?.firmware ?? state.firmware?.current
  return firmware?.trim() || undefined
}

/**
 * The compatibility page matches the catalog's own model title. Qualification
 * reports every Moonraker host as vendor Klipper and model "Moonraker Generic"
 * and still mean `klipper-generic-moonraker`. Follow that report identity.
 */
function catalogProduct(state: PrinterState | null) {
  const identity = state?.identity
  const direct = matchCatalogProduct(
    identity
      ? {
          vendor: identity.vendor ?? null,
          model: identity.model ?? null,
          firmware: identity.firmware ?? null,
        }
      : null,
  )
  if (direct) return direct
  if (!identity) return null
  const vendor = compact(identity.vendor ?? '')
  const model = compact(identity.model ?? '')
  const genericMoonraker =
    (vendor.includes('klipper') || vendor.includes('moonraker')) &&
    (model.length === 0 ||
      model.includes('generic') ||
      model.includes('generico') ||
      model.includes('moonraker'))
  if (
    !genericMoonraker ||
    model.includes('sv08') ||
    model.includes('k1') ||
    model.includes('voron')
  )
    return null
  return matchCatalogProduct({ model: 'klipper-generic-moonraker' })
}

function hardwareBacked(product: AnycubicCatalogProduct) {
  const { capabilities } = product
  return (
    capabilities.telemetry === 'hardware' ||
    controlKeys.every((key) => capabilities[key] === 'hardware')
  )
}

/**
 * Why Shop can or cannot use this printer. Machine specs are not an input.
 * Degradation is reported only after hardware evidence exists, so an
 * unqualified model stays unqualified while it is offline.
 */
export function qualifyPrinter(
  state: PrinterState | null,
): PrinterQualification {
  const product = catalogProduct(state)
  if (!product || !hardwareBacked(product))
    return {
      operation: 'unqualified',
      catalogId: product?.id ?? null,
      evidenceRevision: product ? catalogEvidenceRevision(product) : null,
    }
  const evidenceRevision = catalogEvidenceRevision(product)
  if (state && printerDegradedReason(state))
    return {
      operation: 'temporarily-unavailable',
      catalogId: product.id,
      evidenceRevision,
    }
  const firmware = state ? observedFirmware(state) : undefined
  const proven = qualifiedFirmwareByCatalogId[product.id] ?? []
  if (!firmware || !proven.includes(firmware))
    return {
      operation: 'unknown-firmware',
      catalogId: product.id,
      evidenceRevision,
    }
  const { capabilities } = product
  const supported = controlKeys.every((key) => capabilities[key] === 'hardware')
  return {
    operation: supported ? 'supported-control' : 'monitoring-only',
    catalogId: product.id,
    evidenceRevision,
  }
}

export function qualifyPrinterState(state: unknown): PrinterQualification {
  const parsed = PrinterState.safeParse(state)
  return qualifyPrinter(parsed.success ? parsed.data : null)
}

export async function getIntegrationPrinterCapabilities(
  principal: IntegrationPrincipal,
  reader: {
    readPrinter(printerId: string): Promise<IntegrationPrinterRow | null>
  },
  printerId: string,
) {
  if (!uuidPattern.test(printerId)) return { error: 'not-found' as const }
  const row = await reader.readPrinter(printerId)
  if (
    !row ||
    !integrationGrantFor(principal, 'printers:read', row.farmId, row.id)
  )
    return { error: 'not-found' as const }
  return {
    printerId: row.id,
    ...qualifyPrinterState(row.state),
  }
}
