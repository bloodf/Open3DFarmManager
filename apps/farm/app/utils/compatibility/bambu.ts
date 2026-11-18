export type CatalogCapability =
  'documented' | 'simulated' | 'unknown' | 'unsupported'

export interface BambuCatalogProduct {
  readonly id: string
  readonly brand: string
  readonly model: string
  readonly releaseStatus: string
  readonly releaseDate: string | null
  readonly firmwareStatus: string
  readonly firmwareNotes: readonly {
    readonly firmware: string
    readonly note: string
    readonly sources: readonly string[]
  }[]
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

/**
 * O driver Bambu do OpenFarm é agnóstico ao modelo: `supportedBambuActions`
 * ignora o argumento do modelo
 * (`packages/connector/src/bambu/commands.ts`). Só a câmera é condicionada ao
 * modelo, por `selectBambuCamera`
 * (`packages/connector/src/bambu/camera.ts`).
 *
 * Arquivos continuam desconhecidos: a leitura e o envio por FTPS passivo têm
 * implementação e testes próprios
 * (`packages/connector/src/bambu/files.ts` e `bambu/ftps.ts`), mas
 * `createFileTargets` não monta alvo para a coleção Bambu, então a operação
 * não é alcançável pelo produto
 * (`packages/connector/src/runtime/file-targets.ts`).
 */
const bambuCapabilities = {
  telemetry: 'simulated',
  files: 'unknown',
  camera: 'unknown',
  materials: 'simulated',
  pause: 'simulated',
  resume: 'simulated',
  cancel: 'simulated',
} satisfies BambuCatalogProduct['capabilities']

const common = {
  brand: 'Bambu Lab',
  releaseStatus: 'Anunciada; disponibilidade regional não verificada',
  firmwareStatus: 'não verificado',
  firmwareNotes: [
    {
      firmware: 'não verificado',
      note: 'O anúncio da Bambu introduz controle de autorização para modelos futuros, mas não fixa números de versão aplicáveis a este modelo; a versão instalada não foi verificada e a integração é somente simulada.',
      sources: [
        'https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/',
      ],
    },
  ],
  connection:
    'Integração e requisitos de conexão não verificados para este modelo',
  capabilities: bambuCapabilities,
  limitations: [
    'A data indica a publicação do anúncio, não a disponibilidade em cada região.',
    'Recursos comerciais não comprovam acesso por terceiros ou compatibilidade com o OpenFarm.',
    'Telemetria e comandos foram simulados contra o simulador Bambu; não comprovado em hardware. Comandos exigem ativação LAN.',
    'Arquivos permanecem desconhecidos: a leitura e o envio por FTPS passivo têm implementação e testes, mas nenhuma configuração de coleta monta um alvo de arquivos para a coleção Bambu, então a operação não é alcançável pelo produto.',
    'Materiais: leitura de bandejas AMS e comandos de carga e descarga de filamento foram simulados; não comprovado em hardware.',
    'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
  ],
} satisfies Omit<
  BambuCatalogProduct,
  'id' | 'model' | 'releaseDate' | 'sources'
>

export const bambuCatalog: readonly BambuCatalogProduct[] = [
  {
    ...common,
    id: 'bambu-a2l',
    model: 'A2L',
    releaseDate: '2026-06-01',
    sources: [
      'https://blog.bambulab.com/bambu-lab-a2l-creative-playground-extra-large/',
    ],
    limitations: [
      ...common.limitations,
      'Câmera: o transporte de câmera do OpenFarm não cobre o A2L, que não corresponde ao seletor de modelo aceito; a câmera permanece desconhecida.',
    ],
  },
  {
    ...common,
    id: 'bambu-x2d',
    model: 'X2D',
    releaseDate: '2026-04-14',
    sources: [
      'https://blog.bambulab.com/xcellence-made-simple-bambu-lab-presents-the-x2d/',
    ],
    limitations: [
      ...common.limitations,
      'Câmera: o transporte de câmera do OpenFarm não cobre o X2D, que não corresponde ao seletor de modelo aceito; a câmera permanece desconhecida.',
    ],
  },
  {
    ...common,
    capabilities: { ...bambuCapabilities, camera: 'simulated' },
    id: 'bambu-h2c',
    model: 'H2C',
    releaseDate: '2025-11-14',
    sources: [
      'https://blog.bambulab.com/bambu-lab-h2c-where-multi-material-vortek-system-meets-engineering-precision/',
    ],
    limitations: [
      ...common.limitations,
      'Câmera: o OpenFarm aceita o H2C no seletor de modelo e simula o transporte RTSPS autenticado na porta 322; não comprovado em hardware.',
    ],
  },
  {
    ...common,
    capabilities: { ...bambuCapabilities, camera: 'simulated' },
    id: 'bambu-p2s',
    model: 'P2S',
    releaseDate: '2025-10-14',
    sources: [
      'https://blog.bambulab.com/the-icon-redefined-meet-the-p2s-a-completely-reengineered-version-of-the-ultra-productive-p1-series/',
    ],
    limitations: [
      ...common.limitations,
      'Câmera: o OpenFarm aceita o P2S no seletor de modelo e simula o transporte RTSPS autenticado na porta 322; não comprovado em hardware.',
    ],
  },
  {
    ...common,
    capabilities: { ...bambuCapabilities, camera: 'simulated' },
    id: 'bambu-h2s',
    model: 'H2S',
    releaseDate: '2025-08-26',
    sources: [
      'https://blog.bambulab.com/h2s-the-ultimate-single-nozzle-3d-printer-now-bigger-than-ever/',
    ],
    limitations: [
      ...common.limitations,
      'Câmera: o OpenFarm aceita o H2S no seletor de modelo e simula o transporte RTSPS autenticado na porta 322; não comprovado em hardware.',
    ],
  },
]
