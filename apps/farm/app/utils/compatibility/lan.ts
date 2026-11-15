import type { AnycubicCatalogProduct } from './anycubic'

export const lanCatalog: readonly AnycubicCatalogProduct[] = [
  {
    id: 'anycubic-kobra-3-lan',
    brand: 'Anycubic',
    model: 'Kobra 3 (LAN, modelo 20024)',
    releaseStatus: 'Data de lançamento não verificada neste catálogo',
    releaseDate: null,
    firmwareStatus: 'Versão de firmware não qualificada',
    connection: 'Integração LAN para o identificador de modelo 20024',
    capabilities: {
      telemetry: 'simulated',
      files: 'simulated',
      camera: 'unknown',
      materials: 'unknown',
      pause: 'simulated',
      resume: 'simulated',
      cancel: 'simulated',
    },
    sources: [
      'https://github.com/rvanderp3/kobra-connect/blob/main/docs/mqtt-commands.md',
    ],
    limitations: [
      'Telemetria, início de impressão e comandos LAN simulados; não comprovado em hardware.',
      'Arquivos: apenas início de arquivo existente; envio e listagem não são suportados.',
      'Temperatura, ventilador e luz foram simulados; comandos de filamento ACE não são suportados.',
    ],
  },
  {
    id: 'creality-k1-stock-lan',
    brand: 'Creality',
    model: 'K1 (LAN de fábrica)',
    releaseStatus: 'Data de lançamento não verificada neste catálogo',
    releaseDate: null,
    firmwareStatus: 'Versão de firmware não qualificada',
    connection: 'HTTP e WebSocket LAN de fábrica',
    capabilities: {
      telemetry: 'simulated',
      files: 'simulated',
      camera: 'unknown',
      materials: 'unknown',
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
      'Comandos de filamento não são suportados na integração LAN de fábrica.',
    ],
  },
]
