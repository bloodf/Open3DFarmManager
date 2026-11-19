import type { AnycubicCatalogProduct } from './anycubic.ts'
import { unknownControlAreas } from './control-areas.ts'

export const lanCatalog: readonly AnycubicCatalogProduct[] = [
  {
    id: 'anycubic-kobra-3-lan',
    controlAreas: unknownControlAreas,
    brand: 'Anycubic',
    model: 'Kobra 3 (LAN, modelo 20024)',
    releaseStatus: 'Data de lançamento não verificada neste catálogo',
    releaseDate: null,
    firmwareStatus:
      'Versões publicadas pelo fabricante; não qualificadas em hardware',
    firmwareNotes: [
      {
        firmware: 'V2.4.6.7',
        note: 'O registro de atualizações do fabricante lista V2.4.6.7 como a versão mais recente da Kobra 3; a documentação do modo LAN foi introduzida em V2.3.3.9. A integração LAN não foi qualificada em hardware.',
        sources: [
          'https://wiki.anycubic.com/it/fdm-3d-printer/kobra-3-combo/firmware-upgrade-log',
        ],
      },
    ],
    connection: 'Integração LAN para o identificador de modelo 20024',
    capabilities: {
      telemetry: 'simulated',
      files: 'simulated',
      camera: 'unknown',
      materials: 'unsupported',
      pause: 'simulated',
      resume: 'simulated',
      cancel: 'simulated',
    },
    sources: [
      'https://github.com/rvanderp3/kobra-connect/blob/main/docs/mqtt-commands.md',
      'https://wiki.anycubic.com/it/fdm-3d-printer/kobra-3-combo/firmware-upgrade-log',
    ],
    limitations: [
      'Telemetria, início de impressão e comandos LAN simulados; não comprovado em hardware.',
      'Arquivos: apenas início de arquivo existente; envio e listagem não são suportados.',
      'Temperatura, ventilador e luz foram simulados; comandos de filamento ACE não são suportados.',
      'Materiais: o protocolo LAN documentado não expõe comandos de filamento ACE, e o conector os recusa explicitamente.',
      'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
    ],
  },
  {
    id: 'creality-k1-stock-lan',
    controlAreas: unknownControlAreas,
    brand: 'Creality',
    model: 'K1 (LAN de fábrica)',
    releaseStatus: 'Data de lançamento não verificada neste catálogo',
    releaseDate: null,
    firmwareStatus: 'não verificado',
    firmwareNotes: [
      {
        firmware: 'não verificado',
        note: 'O protocolo LAN de fábrica do K1 é documentado por terceiros, mas nenhuma versão de firmware do K1 foi verificada por este catálogo; a integração LAN não foi qualificada em hardware.',
        sources: [
          'https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp',
        ],
      },
    ],
    connection: 'HTTP e WebSocket LAN de fábrica',
    capabilities: {
      telemetry: 'simulated',
      files: 'simulated',
      camera: 'unknown',
      materials: 'unsupported',
      pause: 'simulated',
      resume: 'simulated',
      cancel: 'simulated',
    },
    sources: [
      'https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp',
    ],
    limitations: [
      'Telemetria, comandos e arquivos simulados; não comprovado em hardware.',
      'Arquivos: envio e início simulados; listagem não é suportada.',
      'Materiais: o protocolo de fábrica não documenta comandos de filamento e o conector os recusa explicitamente.',
      'Câmera: o módulo de câmera do OpenFarm não está ligado ao caminho de configuração do agente, então a câmera permanece desconhecida.',
    ],
  },
]
