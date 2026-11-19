import { unknownControlAreas } from './control-areas.ts'
import type {
  ControlAreaCapabilities,
  ControlAreaEvidenceMap,
} from './control-areas.ts'

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
  readonly controlAreas: ControlAreaCapabilities
  readonly controlAreaEvidence?: ControlAreaEvidenceMap
  readonly sources: readonly string[]
  readonly limitations: readonly string[]
}

/**
 * O driver Creality do OpenFarm é agnóstico ao modelo: `CrealityBinding`
 * (`packages/connector/src/config/creality.ts`) não tem campo de modelo e
 * `supportedCrealityActions` ignora o argumento. Telemetria, pausar, retomar e
 * cancelar são, portanto, o mesmo caminho de código para toda a família
 * Creality coberta por este catálogo.
 *
 * Arquivos: o caminho de estoque é o mesmo para toda a família e foi
 * exercitado contra o simulador, então é `simulated`. O Ender-3 V3 Mega
 * mantém `documented` porque o fabricante documenta a transferência de
 * arquivos por USB, Wi-Fi e nuvem, e `documented` é o rótulo do fabricante,
 * não uma prova do OpenFarm em hardware.
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

const detailTest = 'tests/unit/creality-detail.test.ts'

/**
 * Áreas do painel (E22.2) comprovadas apenas pelo simulador Creality do E16 em
 * loopback, sem impressora física. Cada `simulated` aponta para o teste que o
 * exercita. Fonte dos comandos: docs/protocols/creality-detail.md.
 */
export const crealityControlAreaEvidence = {
  temperatures: {
    file: detailTest,
    test: 'reports temperatures and print status',
  },
  printStatus: {
    file: detailTest,
    test: 'reports temperatures and print status',
  },
  fans: { file: detailTest, test: 'reports fans and the light' },
  leds: { file: detailTest, test: 'reports fans and the light' },
  motion: {
    file: detailTest,
    test: 'sends every supported set frame to the simulator',
  },
  console: { file: detailTest, test: 'console lines follow the E18.1 rules' },
  webcams: { file: detailTest, test: 'advertises the configured camera' },
} as const satisfies ControlAreaEvidenceMap

/**
 * Sem comando ou relato documentado no protocolo LAN de fábrica para estas
 * áreas; ficam indisponíveis. Fonte: docs/protocols/creality-detail.md.
 */
const unsupportedAreas = [
  'extrusion',
  'macros',
  'excludeObject',
  'jobQueue',
  'fileManager',
  'bedMesh',
  'config',
  'services',
  'history',
  'timelapse',
  'power',
  'updates',
] as const
const crealityControlAreas: ControlAreaCapabilities = {
  ...unknownControlAreas,
  ...(Object.fromEntries(
    Object.keys(crealityControlAreaEvidence).map((key) => [key, 'simulated']),
  ) as Partial<ControlAreaCapabilities>),
  ...(Object.fromEntries(
    unsupportedAreas.map((key) => [key, 'unsupported']),
  ) as Partial<ControlAreaCapabilities>),
}
const detailSource =
  'https://github.com/bloodf/Open3DFarmManager/blob/main/docs/protocols/creality-detail.md'
const protocolSource =
  'https://github.com/ChestnutLabs/printer-protocol-orchard/blob/fd5026ef9ec8b6b0f7b22884a2f2389e614c8fdf/protocols/creality.md#L153-L176'
const detailLimitations = [
  'Painel LAN de fábrica simulado em loopback, sem impressora física. Movimento cobre apenas referenciar eixos; ventoinhas e iluminação aceitam ligar e desligar.',
  'Não suportado no painel Creality: gerenciador de arquivos (listagem sem layout de resposta documentado e sem comando de exclusão), extrusão, macros, exclusão de objetos, fila, malha, configuração, serviços, histórico, timelapse, energia e atualizações. Fonte em docs/protocols/creality-detail.md.',
  'Console `gcodeCmd` desativado por padrão; quando ligado, segue as regras do E18.1. Impressoras com Moonraker usam o painel Moonraker.',
  'Câmera depende de uma câmera MJPEG configurada localmente no agente.',
]

export const crealityCatalog: readonly CrealityCatalogProduct[] = [
  {
    id: 'creality-mbox',
    controlAreas: crealityControlAreas,
    controlAreaEvidence: crealityControlAreaEvidence,
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'O guia técnico do fabricante descreve os comandos de carga e descarga de filamento na tela, mas não fixa números de versão nem documenta o protocolo LAN de fábrica; nenhuma versão foi qualificada em hardware.',
        sources: [
          detailSource,
          protocolSource,
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
      detailSource,
      protocolSource,
      'https://www.prnewswire.com/news-releases/creality-debuts-mbox-a-kid-operated-ai-3d-printer-at-329-302934077.html',
      'https://wiki.creality.com/zh/mBox-series/mBox/filament-replacement-guide',
    ],
    limitations: [
      'Produto voltado ao público infantil com venda em canal exclusivo temporário.',
      'O guia técnico oficial descreve extrusão de filamento sem mencionar a sigla FDM.',
      'Recursos do aplicativo móvel e detecção por IA não comprovam API local ou integração com o OpenFarm.',
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
      ...detailLimitations,
    ],
  },
  {
    id: 'creality-ender-3-v3-neo',
    controlAreas: crealityControlAreas,
    controlAreaEvidence: crealityControlAreaEvidence,
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'A página oficial do produto não informa versão de firmware nem protocolo local; nenhuma versão foi qualificada em hardware.',
        sources: [
          detailSource,
          protocolSource,
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
      detailSource,
      protocolSource,
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
      ...detailLimitations,
    ],
  },
  {
    id: 'creality-ender-3-v3-mega',
    controlAreas: crealityControlAreas,
    controlAreaEvidence: crealityControlAreaEvidence,
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
    capabilities: {
      ...crealitySimulatedCapabilities,
      // O fabricante documenta a transferência de arquivos por USB, Wi-Fi e
      // nuvem; `documented` é o rótulo do fabricante, não uma prova do
      // OpenFarm em hardware.
      files: 'documented',
    },
    sources: [
      detailSource,
      protocolSource,
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
      ...detailLimitations,
    ],
  },
  {
    id: 'creality-k3',
    controlAreas: crealityControlAreas,
    controlAreaEvidence: crealityControlAreaEvidence,
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
      detailSource,
      protocolSource,
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
      ...detailLimitations,
    ],
  },
  {
    id: 'creality-ender-3-v4',
    controlAreas: crealityControlAreas,
    controlAreaEvidence: crealityControlAreaEvidence,
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'A página oficial do produto e o anúncio da CES não informam versão de firmware nem protocolo local; nenhuma versão foi qualificada em hardware.',
        sources: [
          detailSource,
          protocolSource,
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
      detailSource,
      protocolSource,
      'https://store.creality.com/products/ender-3-v4-combo-3d-printer',
      'https://www.prnewswire.com/news-releases/from-idea-to-print-creality-sparkx-i7-debuts-at-ces-2026-for-everyday-creators-302655772.html',
    ],
    limitations: [
      'A quinta posição do catálogo permanece em disputa com K2 SE e SPARKX i7 devido à falta de cronologia fechada.',
      'Metadados de criação de página na loja não equivalem a data de lançamento comercial.',
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
      ...detailLimitations,
    ],
  },
]
