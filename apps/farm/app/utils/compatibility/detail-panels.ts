import type { VendorPanelCatalog } from '../printer-detail-view.ts'
import { bambuDetailHardwareNote, bambuDetailUnsupported } from './bambu.ts'
import { crealityDetailLimitations } from './creality.ts'

const anycubicReason =
  'O protocolo LAN documentado oferece temperatura, ventoinha, luz e início de arquivo existente. A listagem de arquivos e os demais painéis não são suportados.'
const anycubicHardwareNote =
  'Telemetria, início de impressão e comandos LAN simulados; não comprovado em hardware.'

type VendorDetailFamily = 'bambu' | 'creality' | 'anycubic' | 'kobra-x'

export const vendorDetailCatalog: Readonly<
  Record<VendorDetailFamily, VendorPanelCatalog>
> = {
  bambu: {
    reason: bambuDetailUnsupported,
    hardwareNote: bambuDetailHardwareNote,
    panelReasons: {
      arquivos:
        'Arquivos por FTPS exigem que o Connector anuncie o gerenciamento de arquivos.',
      console:
        'O Connector precisa anunciar o console G-code para esta atribuição.',
      timelapse:
        'Timelapse por FTPS exige que o Connector anuncie este recurso.',
    },
  },
  creality: {
    reason: crealityDetailLimitations[1],
    panelReasons: {
      console: crealityDetailLimitations[2],
    },
    hardwareNote:
      'Telemetria, arquivos e comandos simulados contra o protocolo LAN de fábrica; não comprovado em hardware.',
  },
  anycubic: {
    reason: anycubicReason,
    hardwareNote: anycubicHardwareNote,
  },
  'kobra-x': {
    reason:
      'A atribuição nativa do Kobra X só oferece leitura. O Connector ainda não encaminha comandos assinados.',
    hardwareNote:
      'O adaptador nativo tem testes simulados; não comprovado em hardware. O agente ainda não encaminha comandos assinados para a atribuição nativa.',
  },
}
