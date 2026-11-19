import type { AnycubicCatalogProduct, CatalogCapability } from './anycubic.ts'
import { unknownControlAreas } from './control-areas.ts'
import type { ControlAreaEvidenceMap } from './control-areas.ts'

export type { CatalogCapability }
export type KlipperCatalogProduct = AnycubicCatalogProduct

/**
 * A família Klipper/Moonraker compartilha os mesmos caminhos de código no
 * OpenFarm: `createFileTargets` não produz alvo de arquivos para a coleção
 * Moonraker (`packages/connector/src/runtime/file-targets.ts`), então arquivos
 * seguem desconhecidos; materiais dependem do espelho Spoolman configurado
 * (`packages/connector/src/runtime/collect.ts`).
 */
const simulatedControl = {
  telemetry: 'simulated',
  files: 'unknown',
  camera: 'simulated',
  materials: 'simulated',
  pause: 'simulated',
  resume: 'simulated',
  cancel: 'simulated',
} as const satisfies KlipperCatalogProduct['capabilities']

const fullMock = 'tests/unit/mock-moonraker-full.test.ts'
const lifecycleMock = 'tests/node/e16-352.test.mjs'

/**
 * Áreas de controle comprovadas somente pelo simulador Moonraker do E16
 * (loopback, porta 0). Cada `simulated` aponta para o teste que o exercita;
 * áreas sem teste em simulador permanecem `unknown`.
 */
export const klipperControlAreaEvidence = {
  temperatures: {
    file: fullMock,
    test: 'exposes toolhead homing/limits, heaters, fans, leds, pins, exclude_object and bed_mesh',
  },
  motion: {
    file: fullMock,
    test: 'exposes toolhead homing/limits, heaters, fans, leds, pins, exclude_object and bed_mesh',
  },
  fans: {
    file: fullMock,
    test: 'exposes toolhead homing/limits, heaters, fans, leds, pins, exclude_object and bed_mesh',
  },
  leds: {
    file: fullMock,
    test: 'exposes toolhead homing/limits, heaters, fans, leds, pins, exclude_object and bed_mesh',
  },
  console: {
    file: fullMock,
    test: 'serves temperature_store, gcode help and notify_gcode_response',
  },
  excludeObject: {
    file: fullMock,
    test: 'exposes toolhead homing/limits, heaters, fans, leds, pins, exclude_object and bed_mesh',
  },
  bedMesh: {
    file: fullMock,
    test: 'exposes toolhead homing/limits, heaters, fans, leds, pins, exclude_object and bed_mesh',
  },
  fileManager: {
    file: fullMock,
    test: 'supports file delete/move/mkdir/download and config root',
  },
  history: {
    file: fullMock,
    test: 'covers history, job queue, power, timelapse, update, services, restarts and proc_stats',
  },
  jobQueue: {
    file: fullMock,
    test: 'covers history, job queue, power, timelapse, update, services, restarts and proc_stats',
  },
  power: {
    file: fullMock,
    test: 'covers history, job queue, power, timelapse, update, services, restarts and proc_stats',
  },
  timelapse: {
    file: fullMock,
    test: 'covers history, job queue, power, timelapse, update, services, restarts and proc_stats',
  },
  services: {
    file: fullMock,
    test: 'covers history, job queue, power, timelapse, update, services, restarts and proc_stats',
  },
  updates: {
    file: fullMock,
    test: 'covers history, job queue, power, timelapse, update, services, restarts and proc_stats',
  },
  printStatus: {
    file: lifecycleMock,
    test: 'Print lifecycle (standby, printing, pause, resume, cancel, complete, error) and macro calls',
  },
  macros: {
    file: lifecycleMock,
    test: 'Print lifecycle (standby, printing, pause, resume, cancel, complete, error) and macro calls',
  },
  webcams: {
    file: lifecycleMock,
    test: 'SV06 and U1 profiles match Docker simulator capabilities and pass discovery + sim-tools verification',
  },
} as const satisfies ControlAreaEvidenceMap

const klipperControlAreas = {
  ...unknownControlAreas,
  ...Object.fromEntries(
    Object.keys(klipperControlAreaEvidence).map((key) => [key, 'simulated']),
  ),
} as KlipperCatalogProduct['controlAreas']

const commonLimitations = [
  'As áreas de controle marcadas como Simulado foram exercitadas apenas no simulador Moonraker em loopback, nunca em hardware; extrusão manual direta, configuração e demais áreas sem teste em simulador permanecem Desconhecido.',
  'Telemetria, câmera, pausar, retomar e cancelar foram exercitados apenas contra simuladores Klipper/Moonraker em loopback, nunca em hardware.',
  'Macros anunciadas e comandos de carregar e descarregar filamento foram exercitados em simulador Moonraker; dependem das macros configuradas e não são comprovados em hardware.',
  'O rótulo Simulado não habilita comandos nem concede autoridade de controle; qualquer comando exige autorização própria do OpenFarm.',
] as const

export const klipperCatalog: readonly KlipperCatalogProduct[] = [
  {
    id: 'klipper-generic-moonraker',
    controlAreas: klipperControlAreas,
    controlAreaEvidence: klipperControlAreaEvidence,
    brand: 'Klipper',
    model: 'Klipper + Moonraker genérico',
    releaseStatus:
      'Software livre de código aberto; sem data de lançamento única (família de versões contínuas)',
    releaseDate: null,
    firmwareStatus:
      'Klipper e Moonraker em versões do usuário; compatibilidade por versão não qualificada',
    firmwareNotes: [
      {
        firmware: 'Klipper do usuário',
        note: 'A versão e a configuração variam; consulte as mudanças de configuração antes de atualizar. https://www.klipper3d.org/Config_Changes.html',
        sources: ['https://www.klipper3d.org/Config_Changes.html'],
      },
    ],
    connection:
      'API HTTP e WebSocket do Moonraker na rede local; autenticação depende da configuração do usuário',
    capabilities: simulatedControl,
    sources: [
      'https://www.klipper3d.org/',
      'https://moonraker.readthedocs.io/en/latest/',
      'https://moonraker.readthedocs.io/en/latest/external_api/printer/',
      'https://moonraker.readthedocs.io/en/latest/external_api/webcams/',
    ],
    limitations: [
      ...commonLimitations,
      'Câmera depende das entradas de webcam configuradas no Moonraker; a leitura da lista de webcams é a única integração coberta.',
      'Arquivos permanecem desconhecidos: o OpenFarm lê e envia arquivos por Moonraker no código, mas nenhuma configuração de coleta produz um alvo de arquivos para a coleção Moonraker, então a operação não é alcançável pelo produto.',
      'Materiais dependem do espelho Spoolman configurado; sem ele, a leitura do filamento ativo não é observada.',
      'Configurações personalizadas, macros e plugins do usuário podem alterar o comportamento esperado.',
    ],
  },
  {
    id: 'creality-k1-series-moonraker-root',
    controlAreas: klipperControlAreas,
    controlAreaEvidence: klipperControlAreaEvidence,
    brand: 'Creality',
    model: 'Série K1 (K1, K1C, K1 Max) com Klipper e Moonraker via root',
    releaseStatus:
      'Linha comercial da Creality; data exata por modelo não verificada neste catálogo',
    releaseDate: null,
    firmwareStatus:
      'Firmware baseado em Klipper com fonte oficial publicada; Moonraker completo exige acesso root e é mantido pela comunidade',
    firmwareNotes: [
      {
        firmware: 'Firmware K1 da Creality',
        note: 'A Creality publica o código baseado em Klipper; o Moonraker depende de instalação adicional. https://github.com/CrealityOfficial/K1_Series_Klipper',
        sources: ['https://github.com/CrealityOfficial/K1_Series_Klipper'],
      },
    ],
    connection:
      'Moonraker na rede local somente após acesso root; o WebSocket de fábrica na porta 9999 é outra integração e consta no catálogo Creality',
    capabilities: simulatedControl,
    sources: [
      'https://github.com/CrealityOfficial/K1_Series_Klipper',
      'https://github.com/Guilouz/Creality-Helper-Script-Wiki',
      'https://moonraker.readthedocs.io/en/latest/',
    ],
    limitations: [
      ...commonLimitations,
      'Obter acesso root pode afetar garantia e estabilidade; este catálogo não recomenda nem automatiza o procedimento.',
      'A versão do Moonraker e a configuração variam conforme o método de instalação; nenhuma foi testada em K1 real.',
      'Câmera integrada não tem protocolo local verificado fora das entradas de webcam do Moonraker.',
      'Arquivos permanecem desconhecidos: nenhuma configuração de coleta produz um alvo de arquivos para a coleção Moonraker.',
      'Materiais dependem do espelho Spoolman configurado; sem ele, a leitura do filamento ativo não é observada.',
    ],
  },
  {
    id: 'voron-2-4-kit',
    controlAreas: klipperControlAreas,
    controlAreaEvidence: klipperControlAreaEvidence,
    brand: 'Voron Design',
    model: 'Voron 2.4 (kit de montagem própria)',
    releaseStatus:
      'Projeto aberto com kits de vários fornecedores; data de lançamento por revisão não verificada',
    releaseDate: null,
    firmwareStatus:
      'Klipper é o firmware de referência do projeto; Moonraker é escolha do montador',
    firmwareNotes: [
      {
        firmware: 'Klipper do montador',
        note: 'A configuração depende da montagem Voron. https://github.com/VoronDesign/Voron-2',
        sources: ['https://github.com/VoronDesign/Voron-2'],
      },
    ],
    connection:
      'Moonraker na rede local conforme a montagem; interface e autenticação definidas pelo montador',
    capabilities: simulatedControl,
    sources: [
      'https://vorondesign.com/voron2.4',
      'https://github.com/VoronDesign/Voron-2',
      'https://www.klipper3d.org/',
    ],
    limitations: [
      ...commonLimitations,
      'Kits e configurações variam por fornecedor e por montagem; um modelo único não representa todas as máquinas.',
      'Câmera, materiais e sistemas de troca dependem de acessórios opcionais não avaliados.',
      'Arquivos permanecem desconhecidos: nenhuma configuração de coleta produz um alvo de arquivos para a coleção Moonraker.',
      'Materiais dependem do espelho Spoolman configurado; sem ele, a leitura do filamento ativo não é observada.',
    ],
  },
  {
    id: 'sovol-sv08',
    controlAreas: klipperControlAreas,
    controlAreaEvidence: klipperControlAreaEvidence,
    brand: 'Sovol',
    model: 'SV08',
    releaseStatus:
      'Modelo comercial da Sovol com página de produto pública; data de lançamento não verificada',
    releaseDate: null,
    firmwareStatus:
      'Baseado em Klipper com repositório de configuração publicado pela Sovol; versão e licença completas não inspecionadas',
    firmwareNotes: [
      {
        firmware: 'Firmware SV08 da Sovol',
        note: 'A Sovol publica o firmware baseado em Klipper; a versão instalada varia. https://github.com/Sovol3d/SV08',
        sources: ['https://github.com/Sovol3d/SV08'],
      },
    ],
    connection:
      'Moonraker na rede local segundo a configuração publicada; autenticação e exposição de rede não verificadas',
    capabilities: simulatedControl,
    sources: [
      'https://www.sovol3d.com/products/sovol-sv08-3d-printer',
      'https://github.com/Sovol3d/SV08',
      'https://moonraker.readthedocs.io/en/latest/',
    ],
    limitations: [
      ...commonLimitations,
      'Nenhum teste em SV08 real foi executado; a classificação decorre da família Klipper/Moonraker.',
      'Câmera opcional e acessórios não foram avaliados.',
      'Arquivos permanecem desconhecidos: nenhuma configuração de coleta produz um alvo de arquivos para a coleção Moonraker.',
      'Materiais dependem do espelho Spoolman configurado; sem ele, a leitura do filamento ativo não é observada.',
    ],
  },
  {
    id: 'voron-trident-kit',
    controlAreas: klipperControlAreas,
    controlAreaEvidence: klipperControlAreaEvidence,
    brand: 'Voron Design',
    model: 'Voron Trident (kit de montagem própria)',
    releaseStatus: 'Projeto aberto; data de lançamento não verificada',
    releaseDate: null,
    firmwareStatus: 'Klipper configurado pelo montador; versão não qualificada',
    firmwareNotes: [
      {
        firmware: 'Klipper do montador',
        note: 'A configuração depende da montagem. https://github.com/VoronDesign/Voron-Trident',
        sources: ['https://github.com/VoronDesign/Voron-Trident'],
      },
    ],
    connection: 'Moonraker na rede local conforme a montagem',
    capabilities: simulatedControl,
    sources: [
      'https://github.com/VoronDesign/Voron-Trident',
      'https://moonraker.readthedocs.io/en/latest/',
    ],
    limitations: [
      ...commonLimitations,
      'Nenhum teste em Trident real foi executado; acessórios e configuração variam por montagem.',
      'Arquivos permanecem desconhecidos: nenhuma configuração de coleta produz um alvo de arquivos para a coleção Moonraker.',
      'Materiais dependem do espelho Spoolman configurado; sem ele, a leitura do filamento ativo não é observada.',
    ],
  },
]

export const klipperFamilyIds: ReadonlySet<string> = new Set(
  klipperCatalog.map((product) => product.id),
)
