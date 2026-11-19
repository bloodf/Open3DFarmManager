import { compatibilityPageCatalog, capabilityStatusLabels } from './index.ts'
import type { AnycubicCatalogProduct, CatalogCapability } from './anycubic.ts'

export interface ObservedPrinterIdentity {
  readonly vendor?: string | null
  readonly model?: string | null
  readonly firmware?: string | null
}

export type CapabilityKey = keyof AnycubicCatalogProduct['capabilities']

export interface IdentifiedCompatibilityMatch {
  readonly identified: true
  readonly product: AnycubicCatalogProduct
  readonly label: string
  readonly brand: string
  readonly model: string
  readonly capabilityStatuses: Readonly<
    Record<CapabilityKey, CatalogCapability>
  >
  readonly statusLabels: Readonly<Record<CapabilityKey, string>>
}

export interface UnidentifiedCompatibilityMatch {
  readonly identified: false
  readonly product: null
  readonly label: 'não identificado'
  readonly brand: null
  readonly model: null
  readonly capabilityStatuses: null
  readonly statusLabels: null
}

export type CompatibilityMatch =
  IdentifiedCompatibilityMatch | UnidentifiedCompatibilityMatch

export const UNIDENTIFIED_LABEL = 'não identificado'

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
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

export function matchCatalogProduct(
  observed: ObservedPrinterIdentity | null | undefined,
  catalog: readonly AnycubicCatalogProduct[] = compatibilityPageCatalog,
): AnycubicCatalogProduct | null {
  if (!observed) return null

  const rawVendor = clean(observed.vendor)
  const rawModel = clean(observed.model)

  if (!rawVendor && !rawModel) return null

  // 1. Direct ID match
  const byExactId = catalog.find(
    (product) =>
      product.id === rawModel ||
      product.id ===
        (rawVendor ? `${rawVendor}-${rawModel}`.toLowerCase() : ''),
  )
  if (byExactId) return byExactId

  const vCompact = compact(rawVendor)
  const mCompact = compact(rawModel)
  const combined = compact(`${rawVendor} ${rawModel}`)

  const isBambuVendor = vCompact.includes('bambu') || vCompact === 'bl'
  const isAnycubicVendor = vCompact.includes('anycubic')
  const isCrealityVendor = vCompact.includes('creality')
  const isKlipperMoonrakerVendor =
    vCompact.includes('klipper') || vCompact.includes('moonraker')
  const isSovolVendor = vCompact.includes('sovol')
  const isVoronVendor = vCompact.includes('voron')

  const strippedModel = stripBrandPrefixes(mCompact)

  // 2. Bambu Lab models
  if (!rawVendor || isBambuVendor) {
    const bambuModels: Record<string, string> = {
      a2l: 'bambu-a2l',
      x2d: 'bambu-x2d',
      h2c: 'bambu-h2c',
      p2s: 'bambu-p2s',
      h2s: 'bambu-h2s',
    }
    const matchedId = bambuModels[strippedModel]
    if (matchedId) {
      const match = catalog.find((product) => product.id === matchedId)
      if (match) return match
    }
  }

  // 3. Anycubic models
  if (!rawVendor || isAnycubicVendor) {
    const anycubicModels: Record<string, string> = {
      kobra3maxv2: 'anycubic-kobra-3-max-v2',
      kobra4: 'anycubic-kobra-4',
      kobrax: 'anycubic-kobra-x',
      kobras1max: 'anycubic-kobra-s1-max',
      kobra3v2: 'anycubic-kobra-3-v2',
    }
    const matchedId = anycubicModels[strippedModel]
    if (matchedId) {
      const match = catalog.find((product) => product.id === matchedId)
      if (match) return match
    }
  }

  // 4. Creality models (native / stock)
  if (!rawVendor || isCrealityVendor) {
    const crealityModels: Record<string, string> = {
      mbox: 'creality-mbox',
      ender3v3neo: 'creality-ender-3-v3-neo',
      ender3v3mega: 'creality-ender-3-v3-mega',
      k3: 'creality-k3',
      ender3v4: 'creality-ender-3-v4',
    }
    const matchedId = crealityModels[strippedModel]
    if (matchedId) {
      const match = catalog.find((product) => product.id === matchedId)
      if (match) return match
    }
  }

  // 5. Klipper / Moonraker family
  // 5a. Creality K1 series via root Moonraker
  if (!rawVendor || isCrealityVendor || isKlipperMoonrakerVendor) {
    if (
      /^(k1|k1c|k1max|k1series|seriek1)$/.test(strippedModel) ||
      mCompact.includes('seriek1') ||
      mCompact.includes('k1series')
    ) {
      const match = catalog.find(
        (product) => product.id === 'creality-k1-series-moonraker-root',
      )
      if (match) return match
    }
  }

  // 5b. Sovol SV08
  if (!rawVendor || isSovolVendor || isKlipperMoonrakerVendor) {
    if (strippedModel === 'sv08' || strippedModel === 'sv8') {
      const match = catalog.find((product) => product.id === 'sovol-sv08')
      if (match) return match
    }
  }

  // 5c. Voron 2.4
  if (!rawVendor || isVoronVendor || isKlipperMoonrakerVendor) {
    if (
      strippedModel === '24' ||
      strippedModel === '24kit' ||
      strippedModel === 'voron24' ||
      strippedModel === 'voron24kit' ||
      mCompact.includes('voron24') ||
      (isVoronVendor && mCompact.includes('24'))
    ) {
      const match = catalog.find((product) => product.id === 'voron-2-4-kit')
      if (match) return match
    }
  }

  // 5d. Generic Klipper + Moonraker
  const isGenericKlipperToken = (val: string) =>
    [
      'klipper',
      'moonraker',
      'generic',
      'generico',
      'klippergenericmoonraker',
      'klipperplusmoonrakergenerico',
      'klipperemoonrakergenerico',
      'klippergeneric',
      'klippermoonraker',
      'klippermoonrakergenerico',
    ].includes(val)

  if (
    isGenericKlipperToken(mCompact) ||
    isGenericKlipperToken(strippedModel) ||
    isGenericKlipperToken(combined) ||
    (isKlipperMoonrakerVendor &&
      (!rawModel || isGenericKlipperToken(mCompact) || mCompact === 'printer'))
  ) {
    const match = catalog.find(
      (product) => product.id === 'klipper-generic-moonraker',
    )
    if (match) return match
  }

  // 6. Generic catalog brand + model matching fallback
  for (const product of catalog) {
    const pBrandCompact = compact(product.brand)
    const pModelCompact = compact(product.model)
    const pCombined = compact(`${product.brand} ${product.model}`)

    if (pCombined === combined) {
      return product
    }

    if (
      pModelCompact === mCompact &&
      (!rawVendor || pBrandCompact === vCompact)
    ) {
      return product
    }

    if (product.id === mCompact || product.id === combined) {
      return product
    }
  }

  return null
}

export function matchCompatibility(
  observed: ObservedPrinterIdentity | null | undefined,
  catalog: readonly AnycubicCatalogProduct[] = compatibilityPageCatalog,
): CompatibilityMatch {
  const product = matchCatalogProduct(observed, catalog)

  if (!product) {
    return {
      identified: false,
      product: null,
      label: UNIDENTIFIED_LABEL,
      brand: null,
      model: null,
      capabilityStatuses: null,
      statusLabels: null,
    }
  }

  const capabilityStatuses = product.capabilities
  const statusLabels = {
    telemetry: capabilityStatusLabels[capabilityStatuses.telemetry],
    files: capabilityStatusLabels[capabilityStatuses.files],
    camera: capabilityStatusLabels[capabilityStatuses.camera],
    materials: capabilityStatusLabels[capabilityStatuses.materials],
    pause: capabilityStatusLabels[capabilityStatuses.pause],
    resume: capabilityStatusLabels[capabilityStatuses.resume],
    cancel: capabilityStatusLabels[capabilityStatuses.cancel],
  }

  return {
    identified: true,
    product,
    label: `${product.brand} ${product.model}`,
    brand: product.brand,
    model: product.model,
    capabilityStatuses,
    statusLabels,
  }
}
