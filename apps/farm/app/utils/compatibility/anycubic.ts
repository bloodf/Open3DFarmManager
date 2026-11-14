export type CatalogCapability =
  'documented' | 'simulated' | 'unknown' | 'unsupported'

export interface AnycubicCatalogProduct {
  readonly id: string
  readonly brand: string
  readonly model: string
  readonly releaseStatus: string
  readonly releaseDate: string | null
  readonly firmwareStatus: string
  readonly connection: string
  readonly capabilities: Readonly<
    Record<
      | 'telemetry'
      | 'files'
      | 'camera'
      | 'materials'
      | 'pause'
      | 'resume'
      | 'cancel',
      CatalogCapability
    >
  >
  readonly sources: readonly string[]
  readonly limitations: readonly string[]
}

const unknownCapabilities = {
  telemetry: 'unknown',
  files: 'unknown',
  camera: 'unknown',
  materials: 'unknown',
  pause: 'unknown',
  resume: 'unknown',
  cancel: 'unknown',
} as const

export const anycubicCatalog: readonly AnycubicCatalogProduct[] = [
  {
    id: 'anycubic-kobra-3-max-v2',
    brand: 'Anycubic',
    model: 'Kobra 3 Max V2',
    releaseStatus: 'Data de lançamento desconhecida',
    releaseDate: null,
    firmwareStatus: 'Versão de firmware desconhecida',
    connection: 'Conexão e API desconhecidas',
    capabilities: unknownCapabilities,
    sources: [
      'https://us.anycubic3d.com/products/kobra-3-max-v2-combo-3d-printer',
    ],
    limitations: [
      'Modelo candidato; disponibilidade e integração não foram verificadas.',
      'Câmera e acessórios não comprovam integração.',
    ],
  },
  {
    id: 'anycubic-kobra-4',
    brand: 'Anycubic',
    model: 'Kobra 4',
    releaseStatus: 'Apresentada em feira; lançamento desconhecido',
    releaseDate: null,
    firmwareStatus: 'Versão de firmware desconhecida',
    connection: 'Conexão e API desconhecidas',
    capabilities: unknownCapabilities,
    sources: [
      'https://www.prnewswire.com/news-releases/anycubic-showcases-next-generation-3d-printing-lineup-at-rapidtct-2026-highlighting-multicolor-fdm-and-large-format-resin-innovation-302743844.html',
    ],
    limitations: [
      'Apresentação em feira não comprova disponibilidade nem integração.',
    ],
  },
  {
    id: 'anycubic-kobra-x',
    brand: 'Anycubic',
    model: 'Kobra X',
    releaseStatus: 'Apresentada na Formnext 2025',
    releaseDate: null,
    firmwareStatus: 'Versão de firmware desconhecida',
    connection: 'Ponte local KobraLink testada somente em simulação',
    capabilities: { ...unknownCapabilities, telemetry: 'simulated' },
    sources: [
      'https://www.prnewswire.com/apac/news-releases/anycubic-introduces-three-breakthrough-products-at-formnext-2025-marking-a-new-step-in-desktop-manufacturing-302620524.html',
    ],
    limitations: [
      'A simulação não comprova suporte ao equipamento físico ou ao firmware.',
      'Câmera e comandos não foram qualificados.',
    ],
  },
  {
    id: 'anycubic-kobra-s1-max',
    brand: 'Anycubic',
    model: 'Kobra S1 Max',
    releaseStatus: 'Apresentada na Formnext 2025',
    releaseDate: null,
    firmwareStatus: 'Versão de firmware desconhecida',
    connection: 'API e autenticação desconhecidas',
    capabilities: unknownCapabilities,
    sources: [
      'https://www.prnewswire.com/apac/news-releases/anycubic-introduces-three-breakthrough-products-at-formnext-2025-marking-a-new-step-in-desktop-manufacturing-302620524.html',
    ],
    limitations: ['Data de lançamento e integração não foram comprovadas.'],
  },
  {
    id: 'anycubic-kobra-3-v2',
    brand: 'Anycubic',
    model: 'Kobra 3 V2',
    releaseStatus: 'Candidata; data de lançamento desconhecida',
    releaseDate: null,
    firmwareStatus: 'Versão de firmware desconhecida',
    connection: 'API e autenticação desconhecidas',
    capabilities: unknownCapabilities,
    sources: ['https://store.anycubic.com/products/kobra-3-v2'],
    limitations: [
      'A quinta posição da matriz permanece incerta.',
      'A página do produto não comprova integração com o OpenFarm.',
    ],
  },
]
