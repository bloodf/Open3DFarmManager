import { anycubicCatalog } from './anycubic'
import { bambuCatalog } from './bambu'
import { crealityCatalog } from './creality'
import type { CatalogCapability, AnycubicCatalogProduct } from './anycubic'

export const compatibilityCatalog: readonly AnycubicCatalogProduct[] = [
  ...anycubicCatalog,
  ...bambuCatalog,
  ...crealityCatalog,
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
