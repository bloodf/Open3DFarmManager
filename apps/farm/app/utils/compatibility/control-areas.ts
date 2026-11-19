import type { CatalogCapability } from './anycubic.ts'

/**
 * Áreas de controle do painel (E18). Cada família do catálogo declara todas as
 * chaves; só a família Klipper/Moonraker é preenchida por este épico, as demais
 * ficam `unknown` até o E22.
 */
export const controlAreaKeys = [
  'temperatures',
  'motion',
  'extrusion',
  'fans',
  'leds',
  'macros',
  'console',
  'printStatus',
  'excludeObject',
  'jobQueue',
  'fileManager',
  'webcams',
  'bedMesh',
  'config',
  'services',
  'history',
  'timelapse',
  'power',
  'updates',
] as const

export type ControlArea = (typeof controlAreaKeys)[number]
export type ControlAreaCapabilities = Readonly<
  Record<ControlArea, CatalogCapability>
>

/** Teste em processo que comprova um status `simulated`. */
export interface ControlAreaEvidence {
  readonly file: string
  readonly test: string
}
export type ControlAreaEvidenceMap = Readonly<
  Partial<Record<ControlArea, ControlAreaEvidence>>
>

export const unknownControlAreas: ControlAreaCapabilities = Object.freeze(
  Object.fromEntries(controlAreaKeys.map((key) => [key, 'unknown'])) as Record<
    ControlArea,
    CatalogCapability
  >,
)

export const controlAreaLabels: Record<ControlArea, string> = {
  temperatures: 'Temperaturas',
  motion: 'Movimento',
  extrusion: 'Extrusão',
  fans: 'Ventoinhas',
  leds: 'Iluminação LED',
  macros: 'Macros',
  console: 'Console',
  printStatus: 'Status da impressão',
  excludeObject: 'Exclusão de objetos',
  jobQueue: 'Fila de impressão',
  fileManager: 'Gerenciador de arquivos',
  webcams: 'Webcams',
  bedMesh: 'Malha da mesa',
  config: 'Configuração',
  services: 'Serviços',
  history: 'Histórico',
  timelapse: 'Timelapse',
  power: 'Energia',
  updates: 'Atualizações',
}
