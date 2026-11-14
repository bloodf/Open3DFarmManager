export type CatalogCapability = 'documented' | 'simulated' | 'unknown' | 'unsupported'

export interface BambuCatalogProduct {
  readonly id: string
  readonly brand: string
  readonly model: string
  readonly releaseStatus: string
  readonly releaseDate: string | null
  readonly firmwareStatus: string
  readonly connection: string
  readonly capabilities: Readonly<Record<'telemetry' | 'files' | 'camera' | 'materials' | 'pause' | 'resume' | 'cancel', CatalogCapability>>
  readonly sources: readonly string[]
  readonly limitations: readonly string[]
}

const capabilities = {
  telemetry: 'unknown', files: 'unknown', camera: 'unknown', materials: 'unknown',
  pause: 'unknown', resume: 'unknown', cancel: 'unknown',
} satisfies BambuCatalogProduct['capabilities']

const common = {
  brand: 'Bambu Lab',
  releaseStatus: 'Anunciada; disponibilidade regional não verificada',
  firmwareStatus: 'Desconhecido para este modelo',
  connection: 'Integração e requisitos de conexão não verificados para este modelo',
  capabilities,
  limitations: [
    'A data indica a publicação do anúncio, não a disponibilidade em cada região.',
    'Recursos comerciais não comprovam acesso por terceiros ou compatibilidade com o OpenFarm.',
    'Firmware, comandos e integração com hardware não foram verificados para este modelo.',
  ],
} satisfies Omit<BambuCatalogProduct, 'id' | 'model' | 'releaseDate' | 'sources'>

export const bambuCatalog: readonly BambuCatalogProduct[] = [
  { ...common, id: 'bambu-a2l', model: 'A2L', releaseDate: '2026-06-01', sources: ['https://blog.bambulab.com/bambu-lab-a2l-creative-playground-extra-large/'] },
  { ...common, id: 'bambu-x2d', model: 'X2D', releaseDate: '2026-04-14', sources: ['https://blog.bambulab.com/xcellence-made-simple-bambu-lab-presents-the-x2d/'] },
  { ...common, id: 'bambu-h2c', model: 'H2C', releaseDate: '2025-11-14', sources: ['https://blog.bambulab.com/bambu-lab-h2c-where-multi-material-vortek-system-meets-engineering-precision/'] },
  { ...common, id: 'bambu-p2s', model: 'P2S', releaseDate: '2025-10-14', sources: ['https://blog.bambulab.com/the-icon-redefined-meet-the-p2s-a-completely-reengineered-version-of-the-ultra-productive-p1-series/'] },
  { ...common, id: 'bambu-h2s', model: 'H2S', releaseDate: '2025-08-26', sources: ['https://blog.bambulab.com/h2s-the-ultimate-single-nozzle-3d-printer-now-bigger-than-ever/'] },
]
