import { protocolCompatibility } from '../../../../packages/farm-protocol/src/version.ts'

export type ConnectorVersion = {
  rtcScope?: 'loopback' | 'lan'
  connectorVersion?: string
  protocolRevision?: number
}
export const connectorUpgradeDoc =
  'https://github.com/bloodf/Open3DFarmManager/blob/main/docs/SELF-HOSTING-UPGRADE.md'
export function connectorVersionView(value: ConnectorVersion = {}) {
  const compatibility = protocolCompatibility(value.protocolRevision)
  return {
    version: value.connectorVersion ?? 'Desconhecida',
    revision:
      value.protocolRevision === undefined
        ? 'Desconhecida'
        : String(value.protocolRevision),
    warning: {
      supported: '',
      older: 'O protocolo deste Connector é antigo. Atualize o Connector.',
      newer:
        'O protocolo deste Connector é mais recente. Atualize o aplicativo.',
      unknown:
        'Compatibilidade desconhecida. Conecte o Connector para consultar sua versão.',
    }[compatibility],
  }
}

export function connectorRtcScopeHint(scope?: ConnectorVersion['rtcScope']) {
  if (scope === 'loopback')
    return 'Acesso WebRTC somente nesta máquina. Para permitir acesso pela rede local, configure rtc.bindAddress no Connector.'
  if (scope === 'lan') return 'Acesso WebRTC pela rede local.'
  return ''
}
