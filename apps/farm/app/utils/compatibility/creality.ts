export type CatalogCapability =
  'documented' | 'simulated' | 'unknown' | 'unsupported'

export interface CrealityCatalogProduct {
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
 * O driver Creality do OpenFarm é agnóstico ao modelo: `CrealityBinding`
 * (`packages/connector/src/config/creality.ts`) não tem campo de modelo e
 * `supportedCrealityActions` ignora o argumento. Telemetria, arquivos,
 * pausar, retomar e cancelar são, portanto, o mesmo caminho de código para
 * toda a família Creality coberta por este catálogo.
 */
const crealitySimulatedCapabilities = {
  telemetry: 'simulated',
  files: 'simulated',
  camera: 'unknown',
  materials: 'unsupported',
  pause: 'simulated',
  resume: 'simulated',
  cancel: 'simulated',
} as const satisfies CrealityCatalogProduct['capabilities']

export const crealityCatalog: readonly CrealityCatalogProduct[] = [
  {
    id: 'creality-mbox',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'O guia técnico do fabricante descreve os comandos de carga e descarga de filamento na tela, mas não fixa números de versão nem documenta o protocolo LAN de fábrica; nenhuma versão foi qualificada em hardware.',
        sources: [
          'https://wiki.creality.com/zh/mBox-series/mBox/filament-replacement-guide',
        ],
      },
    ],
    brand: 'Creality',
    model: 'mBox',
    releaseStatus:
      'Disponibilidade comercial restrita à TikTok Shop nos EUA (2026-11-09 a 2026-12-10)',
    releaseDate: '2026-11-09',
    firmwareStatus: 'não verificado',
    connection:
      'Aplicativo Creality Park citado; LAN, nuvem e autenticação desconhecidas',
    capabilities: crealitySimulatedCapabilities,
    sources: [
      'https://www.prnewswire.com/news-releases/creality-debuts-mbox-a-kid-operated-ai-3d-printer-at-329-302934077.html',
      'https://wiki.creality.com/zh/mBox-series/mBox/filament-replacement-guide',
    ],
    limitations: [
      'Produto voltado ao público infantil com venda em canal exclusivo temporário.',
      'O guia técnico oficial descreve extrusão de filamento sem mencionar a sigla FDM.',
      'Recursos do aplicativo móvel e detecção por IA não comprovam API local ou integração com o OpenFarm.',
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
      'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
    ],
  },
  {
    id: 'creality-ender-3-v3-neo',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'A página oficial do produto não informa versão de firmware nem protocolo local; nenhuma versão foi qualificada em hardware.',
        sources: [
          'https://store.creality.com/products/ender-3-v3-neo-3d-printer',
        ],
      },
    ],
    brand: 'Creality',
    model: 'Ender-3 V3 Neo',
    releaseStatus:
      'Pedidos abertos nas lojas oficiais dos EUA e Europa em 2026-10-15',
    releaseDate: '2026-10-15',
    firmwareStatus: 'não verificado',
    connection:
      'Controle via Creality Cloud anunciado; LAN, Moonraker e autenticação não comprovadas',
    capabilities: crealitySimulatedCapabilities,
    sources: [
      'https://www.prnewswire.com/news-releases/creality-launches-ender-3-v3-mega-combo-at-669-for-large-format-printing-and-batch-production-302909893.html',
      'https://store.creality.com/products/ender-3-v3-neo-3d-printer',
      'https://store.creality.com/uk/blogs/news/ender-3-v3-neo-mega-new-arrival',
    ],
    limitations: [
      'Lançamento empatado em cronologia com o Ender-3 V3 Mega.',
      'Disponibilidade imediata de estoque varia conforme a região.',
      'Câmera integrada declarada não possui protocolo ou streaming local verificado.',
      'CFS Nano é acessório opcional e não constitui modelo separado.',
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
      'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
    ],
  },
  {
    id: 'creality-ender-3-v3-mega',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'A página oficial do produto e o material de lançamento descrevem transferência de arquivos por USB, Wi-Fi e nuvem, mas não fixam números de versão de firmware; nenhuma versão foi qualificada em hardware.',
        sources: ['https://www.creality.com/products/ender-3-v3-mega'],
      },
    ],
    brand: 'Creality',
    model: 'Ender-3 V3 Mega',
    releaseStatus:
      'Pedidos abertos nas lojas oficiais dos EUA e Europa em 2026-10-15',
    releaseDate: '2026-10-15',
    firmwareStatus: 'não verificado',
    connection:
      'Wi-Fi 2,4 GHz e Creality Cloud anunciados; LAN, Moonraker e autenticação não comprovadas',
    capabilities: crealitySimulatedCapabilities,
    sources: [
      'https://www.prnewswire.com/news-releases/creality-launches-ender-3-v3-mega-combo-at-669-for-large-format-printing-and-batch-production-302909893.html',
      'https://store.creality.com/products/ender-3-v3-mega-3d-printer',
      'https://store.creality.com/uk/blogs/news/ender-3-v3-neo-mega-new-arrival',
      'https://www.creality.com/products/ender-3-v3-mega',
    ],
    limitations: [
      'Transferência de arquivos por USB/Wi-Fi/Cloud documentada pelo fabricante, mas protocolo local e autenticação não foram testados.',
      'Câmera Nebula é acessório opcional e a versão Combo é apenas pacote comercial.',
      'Disponibilidade imediata de estoque varia conforme a região.',
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
      'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
    ],
  },
  {
    id: 'creality-k3',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'A FAQ oficial do fabricante descreve base Klipper e acesso root, mas não fixa números de versão nem documenta uma interface Moonraker ativa; nenhuma versão foi qualificada em hardware.',
        sources: ['https://www.creality.com/blog/k3-questions-answered'],
      },
    ],
    brand: 'Creality',
    model: 'K3',
    releaseStatus:
      'Disponibilidade oficial nos EUA anunciada em 2026-11-03 com pré-vendas anteriores',
    releaseDate: '2026-11-03',
    firmwareStatus: 'não verificado',
    connection:
      'Wi-Fi e Creality Cloud citados; LAN, Moonraker e autenticação não comprovadas',
    capabilities: crealitySimulatedCapabilities,
    sources: [
      'https://www.prnewswire.com/news-releases/creality-k3-now-available-at-849-making-multi-color-3d-printing-more-practical-302927557.html',
      'https://www.prnewswire.com/news-releases/creality-k3-opens-for-pre-order-at-849-advancing-multi-color-3d-printing-302906922.html',
      'https://www.creality.com/blog/k3-questions-answered',
      'https://store.creality.com/products/k3-multi-material-multicolor-3d-printer',
    ],
    limitations: [
      'Declaração de firmware baseado em Klipper e acesso root não comprova interface Moonraker ativa ou compatibilidade.',
      'Remessas para a Europa previstas apenas para dezembro de 2026.',
      'Suporte a múltiplos bicos e materiais no Creality Print não qualifica comandos remotos pelo OpenFarm.',
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
      'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
    ],
  },
  {
    id: 'creality-ender-3-v4',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'A página oficial do produto e o anúncio da CES não informam versão de firmware nem protocolo local; nenhuma versão foi qualificada em hardware.',
        sources: [
          'https://store.creality.com/products/ender-3-v4-combo-3d-printer',
        ],
      },
    ],
    brand: 'Creality',
    model: 'Ender-3 V4',
    releaseStatus:
      'Exibida na CES 2026 e listada na loja oficial; data de lançamento formal desconhecida',
    releaseDate: null,
    firmwareStatus: 'não verificado',
    connection:
      'Wi-Fi citado em especificações preliminares; LAN, nuvem e autenticação não comprovadas',
    capabilities: crealitySimulatedCapabilities,
    sources: [
      'https://store.creality.com/products/ender-3-v4-combo-3d-printer',
      'https://www.prnewswire.com/news-releases/from-idea-to-print-creality-sparkx-i7-debuts-at-ces-2026-for-everyday-creators-302655772.html',
    ],
    limitations: [
      'A quinta posição do catálogo permanece em disputa com K2 SE e SPARKX i7 devido à falta de cronologia fechada.',
      'Metadados de criação de página na loja não equivalem a data de lançamento comercial.',
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
      'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
    ],
  },
]
