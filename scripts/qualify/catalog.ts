// SPDX-License-Identifier: MIT
import {
  anycubicCatalog,
  type AnycubicCatalogProduct,
} from '../../apps/farm/app/utils/compatibility/anycubic.ts'
import {
  bambuCatalog,
  type BambuCatalogProduct,
} from '../../apps/farm/app/utils/compatibility/bambu.ts'
import {
  crealityCatalog,
  type CrealityCatalogProduct,
} from '../../apps/farm/app/utils/compatibility/creality.ts'
import {
  isSnapmakerU1CatalogIdentity,
  klipperCatalog,
  snapmakerU1CatalogId,
  type KlipperCatalogProduct,
} from '../../apps/farm/app/utils/compatibility/klipper.ts'
import type {
  CatalogPromotionInfo,
  ObservedIdentity,
  ObservedTelemetry,
  ObservedCamera,
  ObservedFiles,
} from './types.ts'

export type UnifiedCatalogEntry =
  | AnycubicCatalogProduct
  | BambuCatalogProduct
  | CrealityCatalogProduct
  | KlipperCatalogProduct

export const allCatalogEntries: readonly UnifiedCatalogEntry[] = [
  ...anycubicCatalog,
  ...bambuCatalog,
  ...crealityCatalog,
  ...klipperCatalog,
]

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim()
}

function compact(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, '')
}

function stripBrandPrefixes(modelCompact: string): string {
  let s = modelCompact
  if (s.startsWith('bambulab')) {
    s = s.slice('bambulab'.length)
  } else if (s.startsWith('bambu')) {
    s = s.slice('bambu'.length)
  } else if (s.startsWith('bl')) {
    s = s.slice(2)
  } else if (s.startsWith('anycubic')) {
    s = s.slice('anycubic'.length)
  } else if (s.startsWith('creality')) {
    s = s.slice('creality'.length)
  } else if (s.startsWith('sovol')) {
    s = s.slice('sovol'.length)
  } else if (s.startsWith('vorondesign')) {
    s = s.slice('vorondesign'.length)
  } else if (s.startsWith('voron')) {
    s = s.slice('voron'.length)
  }
  return s
}

export function findMatchingCatalogProduct(
  vendor: string,
  model?: string | null,
): UnifiedCatalogEntry | null {
  const rawVendor = clean(vendor)
  const rawModel = clean(model)

  const vCompact = compact(rawVendor)
  const mCompact = compact(rawModel)
  const combined = compact(`${rawVendor} ${rawModel}`)

  if (isSnapmakerU1CatalogIdentity(vCompact, mCompact)) {
    const match = allCatalogEntries.find(
      (entry) => entry.id === snapmakerU1CatalogId,
    )
    if (match) return match
  }

  // 1. Direct ID match
  if (rawModel) {
    const direct = allCatalogEntries.find(
      (entry) =>
        entry.id === rawModel ||
        entry.id === `${vCompact}-${mCompact}` ||
        (entry.id !== snapmakerU1CatalogId && entry.id.endsWith(mCompact)),
    )
    if (direct) return direct
  }

  const isBambuVendor = vCompact.includes('bambu') || vCompact === 'bl'
  const isAnycubicVendor = vCompact.includes('anycubic')
  const isCrealityVendor = vCompact.includes('creality')
  const isKlipperVendor =
    vCompact.includes('klipper') || vCompact.includes('moonraker')

  const strippedModel = stripBrandPrefixes(mCompact)

  if (isBambuVendor) {
    const bambuModels: Record<string, string> = {
      a2l: 'bambu-a2l',
      x2d: 'bambu-x2d',
      h2c: 'bambu-h2c',
      p2s: 'bambu-p2s',
      h2s: 'bambu-h2s',
    }
    const matchedId = bambuModels[strippedModel]
    if (matchedId) {
      const match = allCatalogEntries.find((entry) => entry.id === matchedId)
      if (match) return match
    }
  }

  if (isAnycubicVendor) {
    const anycubicModels: Record<string, string> = {
      kobra3maxv2: 'anycubic-kobra-3-max-v2',
      kobra4: 'anycubic-kobra-4',
      kobrax: 'anycubic-kobra-x',
      kobras1max: 'anycubic-kobra-s1-max',
      kobra3v2: 'anycubic-kobra-3-v2',
    }
    const matchedId = anycubicModels[strippedModel]
    if (matchedId) {
      const match = allCatalogEntries.find((entry) => entry.id === matchedId)
      if (match) return match
    }
  }

  if (isCrealityVendor) {
    const crealityModels: Record<string, string> = {
      mbox: 'creality-mbox',
      ender3v3neo: 'creality-ender-3-v3-neo',
      ender3v3mega: 'creality-ender-3-v3-mega',
      k3: 'creality-k3',
      ender3v4: 'creality-ender-3-v4',
    }
    const matchedId = crealityModels[strippedModel]
    if (matchedId) {
      const match = allCatalogEntries.find((entry) => entry.id === matchedId)
      if (match) return match
    }
  }

  if (isKlipperVendor) {
    if (strippedModel.includes('k1')) {
      const match = allCatalogEntries.find(
        (entry) => entry.id === 'creality-k1-series-moonraker-root',
      )
      if (match) return match
    }
    if (strippedModel.includes('sv08') || strippedModel.includes('sovol')) {
      const match = allCatalogEntries.find((entry) => entry.id === 'sovol-sv08')
      if (match) return match
    }
    if (strippedModel.includes('voron') || strippedModel.includes('24')) {
      const match = allCatalogEntries.find(
        (entry) => entry.id === 'voron-2-4-kit',
      )
      if (match) return match
    }
    // Generic Moonraker default
    const generic = allCatalogEntries.find(
      (entry) => entry.id === 'klipper-generic-moonraker',
    )
    if (generic) return generic
  }

  // Fallback scan
  for (const entry of allCatalogEntries) {
    const entryBrandCompact = compact(entry.brand)
    const entryModelCompact = compact(entry.model)
    if (
      entryModelCompact &&
      mCompact &&
      (entryModelCompact === mCompact || mCompact.includes(entryModelCompact))
    ) {
      if (
        !vCompact ||
        entryBrandCompact.includes(vCompact) ||
        vCompact.includes(entryBrandCompact)
      ) {
        return entry
      }
    }
    if (combined && compact(`${entry.brand} ${entry.model}`) === combined) {
      return entry
    }
  }

  return null
}

export function evaluateCatalogPromotion(
  identity: ObservedIdentity,
  telemetry: ObservedTelemetry,
  camera: ObservedCamera,
  files: ObservedFiles,
  vendor: string,
): CatalogPromotionInfo {
  const match = findMatchingCatalogProduct(
    identity.vendor ?? vendor,
    identity.model,
  )
  const notes: string[] = []

  const provenCapabilities = {
    telemetry: telemetry.observed && telemetry.fields.length > 0,
    camera: camera.reachable,
    files: files.listable,
  }

  if (match) {
    notes.push(
      `Identified catalog entry: ${match.id} (${match.brand} ${match.model})`,
    )
    if (provenCapabilities.telemetry) {
      notes.push(
        `Telemetry observed with ${telemetry.fields.length} active field(s) [${telemetry.fields.join(', ')}]`,
      )
    } else {
      notes.push('Telemetry was not observed during this qualification run')
    }
    if (provenCapabilities.camera) {
      notes.push(`Camera verified reachable via ${camera.kind ?? 'stream'}`)
    } else {
      notes.push('Camera was unreachable or not detected')
    }
    if (provenCapabilities.files) {
      notes.push(`File listing verified with ${files.count} file(s) listed`)
    } else {
      notes.push('File listing was not supported or returned no listable files')
    }
  } else {
    notes.push(
      'No exact match in current compatibility catalog; candidate for catalog addition',
    )
  }

  const canPromoteToHardwareProven = Boolean(
    match && provenCapabilities.telemetry,
  )

  return {
    matchedCatalogId: match?.id ?? null,
    matchedCatalogBrand: match?.brand ?? null,
    matchedCatalogModel: match?.model ?? null,
    currentCapabilities: match ? { ...match.capabilities } : null,
    provenCapabilities,
    canPromoteToHardwareProven,
    promotionNotes: notes,
  }
}
