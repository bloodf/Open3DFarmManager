import { kobraXControlAreas, kobraXDetailSource } from './kobra-x.ts'
import { unknownControlAreas } from './control-areas.ts'
import type {
  ControlAreaCapabilities,
  ControlAreaEvidenceMap,
} from './control-areas.ts'

export type CatalogCapability =
  'hardware' | 'documented' | 'simulated' | 'unknown' | 'unsupported'

export interface AnycubicCatalogProduct {
  readonly id: string
  readonly brand: string
  readonly model: string
  readonly releaseStatus: string
  readonly releaseDate: string | null
  readonly firmwareStatus: string
  readonly firmwareNotes?: readonly {
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
  /**
   * Relatórios de `scripts/qualify-printer.ts` em `docs/hardware-reports/` que
   * sustentam cada status `hardware`. A qualificação é somente leitura, então
   * só telemetria, arquivos e câmera podem ser promovidos por ela.
   */
  readonly hardwareReports?: Readonly<
    Partial<Record<'telemetry' | 'files' | 'camera', readonly string[]>>
  >
  readonly controlAreas: ControlAreaCapabilities
  readonly controlAreaEvidence?: ControlAreaEvidenceMap
  readonly sources: readonly string[]
  readonly limitations: readonly string[]
}

/**
 * Nenhum modelo deste grupo é aceito pelo driver Anycubic: o conector só
 * habilita ações para o identificador de modelo `20024`
 * (`packages/connector/src/anycubic/commands.ts`). Sem esse identificador não
 * há rota de código para telemetria, arquivos ou comandos.
 */
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
    controlAreas: unknownControlAreas,
    brand: 'Anycubic',
    model: 'Kobra 3 Max V2',
    releaseStatus: 'Data de lançamento desconhecida',
    releaseDate: null,
    firmwareStatus: 'não verificado',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'O wiki do fabricante publica guias de atualização por modelo, mas não lista versões para a Kobra 3 Max V2; nenhuma versão foi qualificada em hardware e a fonte não comprova compatibilidade com o OpenFarm.',
        sources: [
          'https://us.anycubic3d.com/products/kobra-3-max-v2-combo-3d-printer',
        ],
      },
    ],
    connection: 'Conexão e API desconhecidas',
    capabilities: unknownCapabilities,
    sources: [
      'https://us.anycubic3d.com/products/kobra-3-max-v2-combo-3d-printer',
    ],
    limitations: [
      'Modelo candidato; disponibilidade e integração não foram verificadas.',
      'Câmera e acessórios não comprovam integração.',
      'O driver Anycubic do OpenFarm só aceita o identificador de modelo 20024; este modelo não é reconhecido.',
    ],
  },
  {
    id: 'anycubic-kobra-4',
    controlAreas: unknownControlAreas,
    brand: 'Anycubic',
    model: 'Kobra 4',
    releaseStatus: 'Apresentada em feira; lançamento desconhecido',
    releaseDate: null,
    firmwareStatus: 'não verificado',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'A apresentação cited pelo fabricante não informa versão de firmware nem canal de atualização para a Kobra 4; nenhuma versão foi qualificada em hardware.',
        sources: [
          'https://www.prnewswire.com/news-releases/anycubic-showcases-next-generation-3d-printing-lineup-at-rapidtct-2026-highlighting-multicolor-fdm-and-large-format-resin-innovation-302743844.html',
        ],
      },
    ],
    connection: 'Conexão e API desconhecidas',
    capabilities: unknownCapabilities,
    sources: [
      'https://www.prnewswire.com/news-releases/anycubic-showcases-next-generation-3d-printing-lineup-at-rapidtct-2026-highlighting-multicolor-fdm-and-large-format-resin-innovation-302743844.html',
    ],
    limitations: [
      'Apresentação em feira não comprova disponibilidade nem integração.',
      'O driver Anycubic do OpenFarm só aceita o identificador de modelo 20024; este modelo não é reconhecido.',
    ],
  },
  {
    id: 'anycubic-kobra-x',
    controlAreas: kobraXControlAreas,
    brand: 'Anycubic',
    model: 'Kobra X',
    releaseStatus: 'Apresentada na Formnext 2025',
    releaseDate: null,
    firmwareStatus:
      'Versões publicadas pelo fabricante; não qualificadas em hardware',
    firmwareNotes: [
      {
        firmware: 'V2.0.2.2',
        note: 'O guia de atualização do fabricante publica o registro de versões do Kobra X, com V2.0.2.2 como entrada mais recente; a versão instalada e a compatibilidade com o OpenFarm não foram qualificadas em hardware.',
        sources: [
          'https://wiki.anycubic.com/fr/fdm-3d-printer/anycubic-kobra-x/firmware-update-guide',
        ],
      },
    ],
    connection:
      'Protocolo LAN nativo documentado; integração direta somente para leitura',
    capabilities: {
      ...unknownCapabilities,
      telemetry: 'simulated',
      files: 'simulated',
      pause: 'simulated',
      resume: 'simulated',
      cancel: 'simulated',
    },
    sources: [
      kobraXDetailSource,
      'https://www.prnewswire.com/apac/news-releases/anycubic-introduces-three-breakthrough-products-at-formnext-2025-marking-a-new-step-in-desktop-manufacturing-302620524.html',
      'https://wiki.anycubic.com/fr/fdm-3d-printer/anycubic-kobra-x/firmware-update-guide',
    ],
    limitations: [
      'O adaptador nativo tem testes simulados; não comprovado em hardware. O agente ainda não encaminha comandos assinados para a atribuição nativa.',
      'Os slots ACE aparecem quando a impressora os informa. A câmera nativa ainda não está ligada à sessão de mídia.',
    ],
  },
  {
    id: 'anycubic-kobra-s1-max',
    controlAreas: unknownControlAreas,
    brand: 'Anycubic',
    model: 'Kobra S1 Max',
    releaseStatus: 'Apresentada na Formnext 2025',
    releaseDate: null,
    firmwareStatus: 'não verificado',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'O wiki do fabricante publica um guia de atualização com verificação de versão no próprio painel, mas não fixa números de versão para a Kobra S1 Max; nenhuma versão foi qualificada em hardware.',
        sources: [
          'https://wiki.anycubic.com/en/fdm-3d-printer/kobra-s1-max-combo/firmware-updating-guide',
        ],
      },
    ],
    connection: 'API e autenticação desconhecidas',
    capabilities: unknownCapabilities,
    sources: [
      'https://www.prnewswire.com/apac/news-releases/anycubic-introduces-three-breakthrough-products-at-formnext-2025-marking-a-new-step-in-desktop-manufacturing-302620524.html',
    ],
    limitations: [
      'Data de lançamento e integração não foram comprovadas.',
      'O driver Anycubic do OpenFarm só aceita o identificador de modelo 20024; este modelo não é reconhecido.',
    ],
  },
  {
    id: 'anycubic-kobra-3-v2',
    controlAreas: unknownControlAreas,
    brand: 'Anycubic',
    model: 'Kobra 3 V2',
    releaseStatus: 'Candidata; data de lançamento desconhecida',
    releaseDate: null,
    firmwareStatus: 'não verificado',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'O manual do fabricante disponível não fixa números de versão para a Kobra 3 V2; nenhuma versão foi qualificada em hardware e a fonte não comprova compatibilidade com o OpenFarm.',
        sources: [
          'https://wiki.anycubic.com/k3-v2/Anycubic%20Kobra%203%20V2%20combo%20User%20Manual-EN-V1.0.pdf',
        ],
      },
    ],
    connection: 'API e autenticação desconhecidas',
    capabilities: unknownCapabilities,
    sources: ['https://store.anycubic.com/products/kobra-3-v2'],
    limitations: [
      'A quinta posição da matriz permanece incerta.',
      'A página do produto não comprova integração com o OpenFarm.',
      'O driver Anycubic do OpenFarm só aceita o identificador de modelo 20024; este modelo não é reconhecido.',
    ],
  },
]
