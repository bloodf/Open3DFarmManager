import { anycubicCatalog } from './anycubic.ts'
import { bambuCatalog } from './bambu.ts'
import { crealityCatalog } from './creality.ts'
import { lanCatalog } from './lan.ts'
import { klipperCatalog, klipperFamilyIds } from './klipper.ts'
export { controlAreaKeys, controlAreaLabels } from './control-areas.ts'
export type { ControlArea } from './control-areas.ts'
import type { CatalogCapability, AnycubicCatalogProduct } from './anycubic.ts'

export const compatibilityCatalog: readonly AnycubicCatalogProduct[] = [
  ...anycubicCatalog,
  ...bambuCatalog,
  ...crealityCatalog,
  ...lanCatalog,
]

export { klipperCatalog, klipperFamilyIds }

/** Catálogo exibido na página: marcas existentes mais a família Klipper/Moonraker. */
export const compatibilityPageCatalog: readonly AnycubicCatalogProduct[] = [
  ...compatibilityCatalog,
  ...klipperCatalog,
]

export const capabilityLabels: Record<
  keyof AnycubicCatalogProduct['capabilities'],
  string
> = {
  telemetry: 'Telemetria',
  files: 'Arquivos',
  camera: 'Câmera',
  materials: 'Materiais',
  pause: 'Pausar',
  resume: 'Retomar',
  cancel: 'Cancelar',
}
export const capabilityStatusLabels: Record<CatalogCapability, string> = {
  hardware: 'Comprovado em hardware',
  'reference-matched': 'Validado com a referência',
  documented: 'Documentado',
  simulated: 'Simulado',
  unknown: 'Desconhecido',
  unsupported: 'Não suportado',
}

export function filterCompatibility(
  query: string,
  products: readonly AnycubicCatalogProduct[] = compatibilityCatalog,
) {
  const term = query.trim().toLocaleLowerCase('pt-BR')
  return products.filter((product) =>
    `${product.brand} ${product.model}`
      .toLocaleLowerCase('pt-BR')
      .includes(term),
  )
}
