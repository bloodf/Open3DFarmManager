import { describe, expect, it } from 'vitest'
import {
  protocolCompatibility,
  SUPPORTED_PROTOCOL_REVISION,
} from '../../packages/farm-protocol/src/version.ts'
import { StatusMessage } from '../../packages/farm-protocol/src/channel.ts'
import { connectorVersionView } from '../../apps/farm/app/utils/connector-version.ts'
import { projectStatus } from '../../packages/connector/src/status/local.ts'

describe('Connector version compatibility', () => {
  it('checks inclusive bounds and older/newer revisions', () => {
    expect(protocolCompatibility(SUPPORTED_PROTOCOL_REVISION.min)).toBe(
      'supported',
    )
    expect(protocolCompatibility(SUPPORTED_PROTOCOL_REVISION.max)).toBe(
      'supported',
    )
    expect(protocolCompatibility(0)).toBe('older')
    expect(protocolCompatibility(2)).toBe('newer')
  })
  it.each([undefined, null, '1', -1, 1.5, NaN, Infinity])(
    'treats %s as unknown',
    (revision) => {
      expect(protocolCompatibility(revision)).toBe('unknown')
    },
  )
  it('keeps legacy snapshots valid and carries metadata', () => {
    expect(
      StatusMessage.parse({ t: 'snapshot', seq: 0, printers: [] }),
    ).toEqual({ t: 'snapshot', seq: 0, printers: [] })
    expect(
      StatusMessage.parse({
        t: 'snapshot',
        seq: 0,
        printers: [],
        connectorVersion: '0.0.1',
        protocolRevision: 2,
      }).protocolRevision,
    ).toBe(2)
  })
  it('projects version metadata without exposing extra runtime values', () => {
    expect(
      projectStatus({
        queueDepth: 0,
        delivered: 0,
        retries: 0,
        credentialExpired: false,
      }),
    ).toEqual({
      queueDepth: 0,
      delivered: 0,
      retries: 0,
      credentialExpired: false,
      connectorVersion: '0.0.1',
      protocolRevision: 1,
    })
  })
  it('explains older, newer, supported and unknown in Portuguese', () => {
    expect(connectorVersionView({ protocolRevision: 0 }).warning).toBe(
      'O protocolo deste Connector é antigo. Atualize o Connector.',
    )
    expect(connectorVersionView({ protocolRevision: 2 }).warning).toBe(
      'O protocolo deste Connector é mais recente. Atualize o aplicativo.',
    )
    expect(
      connectorVersionView({ connectorVersion: '0.0.1', protocolRevision: 1 }),
    ).toEqual({ version: '0.0.1', revision: '1', warning: '' })
    expect(connectorVersionView()).toEqual({
      version: 'Desconhecida',
      revision: 'Desconhecida',
      warning:
        'Compatibilidade desconhecida. Conecte o Connector para consultar sua versão.',
    })
  })
})
