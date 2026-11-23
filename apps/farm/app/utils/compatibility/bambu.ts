import { unknownControlAreas } from './control-areas.ts'
import type {
  ControlAreaCapabilities,
  ControlAreaEvidenceMap,
} from './control-areas.ts'

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
  readonly controlAreas: ControlAreaCapabilities
  readonly controlAreaEvidence?: ControlAreaEvidenceMap
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
 * Arquivos seguem o caminho FTPS passivo, implementado e coberto por testes
 * (`packages/connector/src/bambu/files.ts` e `bambu/ftps.ts`). O alvo usa a
 * atribuição local provisionada e a credencial privada do Connector.
 */
const bambuCapabilities = {
  telemetry: 'simulated',
  files: 'simulated',
  camera: 'unknown',
  materials: 'simulated',
  pause: 'simulated',
  resume: 'simulated',
  cancel: 'simulated',
} satisfies BambuCatalogProduct['capabilities']

const detailTest = 'tests/unit/bambu-detail.test.ts'
const extendedTest = 'tests/unit/bambu-control-extended.test.ts'

/**
 * Áreas do painel (E18) comprovadas apenas pelo simulador Bambu do E16 em
 * loopback, sem impressora física. Cada `simulated` aponta para o teste
 * que exercita a área.
 */
export const bambuControlAreaEvidence = {
  temperatures: { file: detailTest, test: 'reports temperatures' },
  fans: { file: detailTest, test: 'reports fans' },
  leds: { file: detailTest, test: 'reports the chamber light' },
  printStatus: { file: detailTest, test: 'reports print status with layers' },
  motion: { file: extendedTest, test: 'jogs and homes through gcode_line' },
  extrusion: { file: extendedTest, test: 'extrudes through gcode_line' },
  console: { file: extendedTest, test: 'console lines follow the E18.1 rules' },
  fileManager: {
    file: detailTest,
    test: 'lists, downloads and deletes SD card files over FTPS',
  },
  timelapse: { file: detailTest, test: 'lists timelapse files over FTPS' },
} as const satisfies ControlAreaEvidenceMap

/**
 * Sem comando ou relato documentado no protocolo LAN da Bambu para estas
 * áreas; ficam indisponíveis. Fonte: docs/protocols/bambu-detail.md.
 */
const unsupportedAreas = [
  'config',
  'bedMesh',
  'services',
  'power',
  'jobQueue',
  'updates',
  'macros',
  'excludeObject',
  'history',
] as const
const withAreas = (
  evidence: ControlAreaEvidenceMap,
): BambuCatalogProduct['controlAreas'] => ({
  ...unknownControlAreas,
  ...Object.fromEntries(Object.keys(evidence).map((k) => [k, 'simulated'])),
  ...Object.fromEntries(unsupportedAreas.map((k) => [k, 'unsupported'])),
})
const baseControlAreas = withAreas(bambuControlAreaEvidence)
const rtspsCameraLimitation =
  'A captura de câmera por RTSPS está indisponível no OpenFarm.'
export const bambuDetailUnsupported =
  'Não suportado no painel Bambu: editor de configuração, malha da mesa, serviços, energia, fila de impressão, atualizações além das versões de firmware, macros, exclusão de objetos e histórico. O protocolo LAN documentado não os expõe; fonte em docs/protocols/bambu-detail.md.'
export const bambuDetailHardwareNote =
  'Painel de detalhe: temperaturas, ventoinhas, luz da câmara, referenciar, mover, extrudar e console via gcode_line, níveis de velocidade, bandejas AMS, estado da impressão com camadas, arquivos do cartão SD e timelapse por FTPS foram exercitados somente no simulador em loopback; não comprovado em hardware. A posição do cabeçote não é informada pelo protocolo.'

const common = {
  controlAreas: baseControlAreas,
  controlAreaEvidence: bambuControlAreaEvidence,
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
    bambuDetailHardwareNote,
    bambuDetailUnsupported,
    'A data indica a publicação do anúncio, não a disponibilidade em cada região.',
    'Recursos comerciais não comprovam acesso por terceiros ou compatibilidade com o OpenFarm.',
    'Telemetria, envio de arquivos e comandos foram simulados; não comprovado em hardware. Comandos exigem ativação LAN.',
    'Arquivos: leitura e envio por FTPS passivo foram exercitados contra o simulador com endereço local, TLS fixado e credencial privada; não comprovado em hardware.',
    'Materiais: leitura de bandejas AMS e comandos de carga e descarga de filamento foram simulados; não comprovado em hardware.',
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
    id: 'bambu-h2c',
    model: 'H2C',
    releaseDate: '2025-11-14',
    sources: [
      'https://blog.bambulab.com/bambu-lab-h2c-where-multi-material-vortek-system-meets-engineering-precision/',
    ],
    limitations: [...common.limitations, rtspsCameraLimitation],
  },
  {
    ...common,
    id: 'bambu-p2s',
    model: 'P2S',
    releaseDate: '2025-10-14',
    sources: [
      'https://blog.bambulab.com/the-icon-redefined-meet-the-p2s-a-completely-reengineered-version-of-the-ultra-productive-p1-series/',
    ],
    limitations: [...common.limitations, rtspsCameraLimitation],
  },
  {
    ...common,
    id: 'bambu-h2s',
    model: 'H2S',
    releaseDate: '2025-08-26',
    sources: [
      'https://blog.bambulab.com/h2s-the-ultimate-single-nozzle-3d-printer-now-bigger-than-ever/',
    ],
    limitations: [...common.limitations, rtspsCameraLimitation],
  },
]
