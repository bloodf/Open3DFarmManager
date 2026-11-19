import type { PrintFileMetadata } from './metadata.ts'

type Dimensions = { x: number; y: number; z?: number }

export interface CompatibilityMetadata extends PrintFileMetadata {
  format?: 'gcode' | '3mf'
  sliced?: boolean
  /** Extents in millimetres, measured along the printer axes. */
  boundingBox?: Dimensions
}

export interface CompatibilityProfile {
  model: string
  compatibleModels?: readonly string[]
  /** Nozzle diameters in millimetres, indexed by tool number. */
  nozzleDiameters: readonly number[]
  bedSize?: Dimensions
}

export interface LoadedMaterial {
  type?: string
  colour?: string
}

export interface CompatibilityReason {
  level: 'info' | 'warn' | 'block'
  message: string
}

export function checkCompatibility(
  meta: CompatibilityMetadata,
  profile: CompatibilityProfile,
  materials: readonly (LoadedMaterial | undefined)[],
): { level: 'ok' | 'warn' | 'block'; reasons: CompatibilityReason[] } {
  const reasons: CompatibilityReason[] = []
  const add = (level: CompatibilityReason['level'], message: string) => {
    reasons.push({ level, message })
  }

  if (meta.format === '3mf') {
    if (meta.sliced === false) {
      add('block', 'O arquivo 3MF precisa ser fatiado antes de imprimir.')
    } else if (meta.sliced === undefined) {
      add('warn', 'O arquivo 3MF não informa se foi fatiado.')
    }
  }

  if (!meta.printerModel) {
    add('warn', 'O arquivo não informa o modelo da impressora.')
  } else if (
    meta.printerModel !== profile.model &&
    !profile.compatibleModels?.includes(meta.printerModel)
  ) {
    add('block', 'O modelo de impressora indicado no arquivo é incompatível.')
  }

  if (!meta.tools?.length) {
    add('warn', 'O arquivo não informa as ferramentas de impressão.')
  }
  meta.tools?.forEach((tool, index) => {
    const slot = index + 1
    if (index >= profile.nozzleDiameters.length) {
      add(
        'block',
        `A impressora não tem a ferramenta ${slot} exigida pelo arquivo.`,
      )
      return
    }
    if (tool.nozzleDiameter === undefined) {
      add(
        'warn',
        `O arquivo não informa o diâmetro do bico da ferramenta ${slot}.`,
      )
    } else if (tool.nozzleDiameter !== profile.nozzleDiameters[index]) {
      add(
        'block',
        `O diâmetro do bico da ferramenta ${slot} difere do indicado no arquivo.`,
      )
    }

    const material = materials[index]
    if (!tool.filamentType) {
      add(
        'warn',
        `O arquivo não informa o tipo de material da ferramenta ${slot}.`,
      )
    } else if (
      material?.type &&
      normalize(tool.filamentType) !== normalize(material.type)
    ) {
      add(
        'warn',
        `O tipo de material carregado na ferramenta ${slot} difere do indicado no arquivo.`,
      )
    }
    if (
      tool.filamentColour &&
      material?.colour &&
      normalize(tool.filamentColour) !== normalize(material.colour)
    ) {
      add(
        'info',
        `A cor do material da ferramenta ${slot} difere da indicada no arquivo.`,
      )
    }
  })

  const { boundingBox } = meta
  const { bedSize } = profile
  if (
    boundingBox &&
    bedSize &&
    (boundingBox.x > bedSize.x ||
      boundingBox.y > bedSize.y ||
      (boundingBox.z !== undefined &&
        bedSize.z !== undefined &&
        boundingBox.z > bedSize.z))
  ) {
    add(
      'block',
      'As dimensões da peça excedem a área ou a altura de impressão.',
    )
  }

  const level = reasons.some((reason) => reason.level === 'block')
    ? 'block'
    : reasons.some((reason) => reason.level === 'warn')
      ? 'warn'
      : 'ok'
  return { level, reasons }
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
