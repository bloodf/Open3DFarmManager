// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import {
  libraryReplayPrinters,
  sendWithoutSession,
  type LibraryReplayAssignment,
} from '../../apps/farm/app/utils/library-replay'
import {
  disabledReason,
  groupPrinters,
  type ReplaySource,
} from '../../apps/farm/app/utils/replay-view'

const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const row = (
  printerKey: string,
  extra: Partial<LibraryReplayAssignment> = {},
): LibraryReplayAssignment => ({
  assignmentId: `${printerKey}-id`,
  agentId: AGENT,
  printerKey,
  status: 'active',
  connectorStatus: 'approved',
  ...extra,
})
const source: ReplaySource = {
  sha256: 'a'.repeat(64),
  name: 'vaso.gcode',
  kind: 'gcode',
  plateCount: 1,
  storageLocation: 'server',
  agentId: null,
  metadata: { tools: [{ nozzleDiameter: 0.4, filamentType: 'PLA' }] },
}

describe('libraryReplayPrinters', () => {
  it('lists active printers of approved Connectors with their profile', () => {
    const printers = libraryReplayPrinters(
      [
        row('voron', { displayName: 'Voron da bancada' }),
        row('antiga', { status: 'revoked' }),
        row('pendente', { connectorStatus: 'pending' }),
      ],
      [
        {
          assignmentId: 'voron-id',
          effective: {
            values: { model: 'Voron 2.4', nozzleDiameterMm: 0.4 },
            compatibleModels: ['Voron 2.4'],
          },
        },
      ],
    )
    expect(printers).toEqual([
      {
        key: 'voron',
        label: 'Voron da bancada',
        agentId: AGENT,
        model: 'Voron 2.4',
        compatibleModels: ['Voron 2.4'],
        nozzleDiameters: [0.4],
        connectorOnline: true,
        live: false,
        materials: [],
      },
    ])
  })

  it('keeps a printer without profile and never makes it pickable', () => {
    const printers = libraryReplayPrinters([row('ender')], [])
    expect(printers[0]).toMatchObject({
      label: 'ender',
      model: '',
      nozzleDiameters: [],
    })
    expect(disabledReason(source, printers[0]!)).toBe(
      'Não há conexão direta segura com o Connector. Nenhum comando pode ser enviado.',
    )
    const groups = groupPrinters(source, printers)
    expect([...groups.ok, ...groups.warn]).toEqual([])
    expect(groups.blocked).toHaveLength(1)
  })
})

describe('sendWithoutSession', () => {
  it('reports that nothing was sent', async () => {
    await expect(sendWithoutSession()).resolves.toEqual({
      outcome: 'not-sent',
    })
  })
})
