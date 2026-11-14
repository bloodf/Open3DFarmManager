import { describe, expect, it } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
  validateUpload,
} from '../../apps/farm/app/utils/files-view.ts'
describe('upload validation', () => {
  it('accepts supported files through the size limit', () => {
    expect(
      validateUpload({ name: 'peca.GCODE', size: MAX_UPLOAD_BYTES }),
    ).toBeUndefined()
    expect(validateUpload({ name: 'peca.3mf', size: 1 })).toBeUndefined()
  })
  it('rejects invalid extension and sizes before sending', () => {
    for (const file of [
      { name: 'x.exe', size: 1 },
      { name: 'x.gcode', size: 0 },
      { name: 'x.3mf', size: MAX_UPLOAD_BYTES + 1 },
      { name: 'x.gcode', size: NaN },
    ])
      expect(validateUpload(file)).toBeTypeOf('string')
  })
})

import { vi } from 'vitest'
import {
  filesAvailability,
  printableFile,
  printOutcomeText,
} from '../../apps/farm/app/utils/files-view.ts'
import {
  createFilesSession,
  type FilesState,
  type PrinterFile,
} from '../../apps/farm/app/utils/files-view-session.ts'
import type {
  FarmRow,
  FarmKeyState,
} from '../../apps/farm/app/utils/farm-view.ts'
import type { FarmPauseControl } from '../../apps/farm/app/utils/webrtc/farm-pause-control.ts'

const clock = { wall: 100_000, mono: 50_000 }
const keys: FarmKeyState = {
  kind: 'available',
  choices: [{ keyId: 'key', thumbprint: 'thumb' }],
  selected: 'key',
}
function printerRow(): FarmRow {
  return {
    assignment: {
      assignmentId: 'assignment',
      agentId: 'agent',
      printerKey: 'printer',
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: 'authenticated',
    localOrigin: null,
    observation: {
      state: {
        printerKey: 'printer',
        state: 'idle',
        observedAt: 99_000,
        controls: ['start_print'],
      },
      received: { wall: 99_000, mono: 49_000 },
      sourceClockComparable: true,
      historical: false,
    },
  }
}
describe('files permissions', () => {
  it('requires explicit start_print advertisement, including legacy snapshots', () => {
    const row = printerRow()
    expect(filesAvailability(row, keys, true, clock)).toEqual({
      available: true,
    })
    if (!row.observation) throw Error('fixture')
    row.observation.state.controls = []
    expect(filesAvailability(row, keys, true, clock).available).toBe(false)
    delete row.observation.state.controls
    expect(filesAvailability(row, keys, true, clock).available).toBe(false)
  })
  it('fails closed on degraded, stale, historical, revoked and unapproved scopes', () => {
    const disconnected = printerRow()
    disconnected.connection = 'closed'
    const historical = printerRow()
    if (historical.observation) historical.observation.historical = true
    const stale = printerRow()
    if (stale.observation) stale.observation.received = { wall: 0, mono: 0 }
    const revoked = printerRow()
    revoked.assignment.status = 'revoked'
    for (const row of [disconnected, historical, stale, revoked])
      expect(filesAvailability(row, keys, true, clock).available).toBe(false)
    expect(filesAvailability(printerRow(), keys, false, clock).available).toBe(
      false,
    )
    expect(
      filesAvailability(printerRow(), { kind: 'loading' }, true, clock)
        .available,
    ).toBe(false)
  })
  it('validates transfer names and command paths using existing protocol rules', () => {
    for (const name of ['../x.gcode', 'pasta/x.gcode', 'á.gcode', 'x..gcode'])
      expect(validateUpload({ name, size: 1 })).toBeTypeOf('string')
    expect(printableFile('peca.gcode')).toBe(true)
    for (const name of ['../peca.gcode', 'pasta/peca.gcode', 'x\u0000.gcode'])
      expect(printableFile(name)).toBe(false)
  })
  it('distinguishes applied, rejected and uncertain command outcomes', () => {
    expect(printOutcomeText('applied')).toContain('Impressão iniciada')
    expect(printOutcomeText('rejected')).toContain('recusou')
    expect(printOutcomeText('not-sent')).toContain('não foi enviado')
    expect(printOutcomeText('outcome-unknown')).toContain(
      'Resultado desconhecido',
    )
    expect(printOutcomeText(undefined)).toContain('Resultado desconhecido')
  })
})

function harness(
  overrides: Partial<
    Pick<FarmPauseControl, 'listFiles' | 'sendFile' | 'issueControlCommand'>
  > = {},
) {
  const states: FilesState[] = []
  let files: PrinterFile[] = []
  const session = {
    listFiles: vi.fn<FarmPauseControl['listFiles']>().mockResolvedValue({
      type: 'files.list.result',
      request_id: 'req',
      printer_key: 'printer',
      ok: true,
      files: [{ name: 'peca.gcode', size: 3, modified: 0 }],
    }),
    sendFile: vi
      .fn<FarmPauseControl['sendFile']>()
      .mockResolvedValue({ type: 'result', transfer_id: 'transfer', ok: true }),
    issueControlCommand: vi
      .fn<FarmPauseControl['issueControlCommand']>()
      .mockResolvedValue('applied'),
    close: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  const connect = vi.fn().mockResolvedValue(session)
  let available = true
  const view = createFilesSession({
    connect,
    available: () => available,
    changed: (value) => states.push(value),
    files: (value) => {
      files = value
    },
  })
  return {
    view,
    session,
    connect,
    states,
    get files() {
      return files
    },
    disable() {
      available = false
    },
  }
}
describe('files session flow', () => {
  it('lists existing files and disposes the operation session', async () => {
    const h = harness()
    await h.view.list('printer')
    expect(h.session.listFiles).toHaveBeenCalledWith('printer')
    expect(h.files).toEqual([{ name: 'peca.gcode', size: 3, modified: 0 }])
    expect(h.states.at(-1)).toEqual({
      kind: 'done',
      message: 'Arquivos atualizados.',
    })
    expect(h.session.close).toHaveBeenCalled()
    expect(h.session.dispose).toHaveBeenCalled()
  })
  it('handles empty lists and remote refusal', async () => {
    const empty = harness({
      listFiles: async () => ({
        type: 'files.list.result',
        request_id: 'req',
        printer_key: 'printer',
        ok: true,
        files: [],
      }),
    })
    await empty.view.list('printer')
    expect(empty.states.at(-1)).toEqual({
      kind: 'done',
      message: 'Nenhum arquivo nesta impressora.',
    })
    const rejected = harness({
      listFiles: async () => ({
        type: 'files.list.result',
        request_id: 'req',
        printer_key: 'printer',
        ok: false,
        reason: 'offline',
      }),
    })
    await rejected.view.list('printer')
    expect(rejected.states.at(-1)?.kind).toBe('error')
  })
  it('rejects invalid upload before opening any session', async () => {
    const h = harness()
    await h.view.upload('printer', new File(['abc'], 'x.exe'))
    expect(h.connect).not.toHaveBeenCalled()
    expect(h.states.at(-1)?.kind).toBe('error')
  })
  it('hashes the file, forwards acknowledged progress and never automatically prints', async () => {
    const sendFile = vi
      .fn<FarmPauseControl['sendFile']>()
      .mockImplementation(async (_offer, _file, _signal, progress) => {
        progress?.(2)
        progress?.(3)
        return { type: 'result', transfer_id: 'transfer', ok: true }
      })
    const h = harness({ sendFile })
    const file = new File(['abc'], 'peca.gcode')
    await h.view.upload('printer', file)
    expect(sendFile.mock.calls[0]?.[0]).toMatchObject({
      type: 'offer',
      printer_key: 'printer',
      name: 'peca.gcode',
      size: 3,
      sha256:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })
    expect(h.states).toContainEqual({ kind: 'uploading', sent: 2, total: 3 })
    expect(h.states.at(-1)?.kind).toBe('done')
    expect(h.files[0]?.name).toBe('peca.gcode')
    expect(h.session.issueControlCommand).not.toHaveBeenCalled()
  })
  it('shows upload failure without publishing an uploaded file', async () => {
    const h = harness({
      sendFile: async () => ({
        type: 'result',
        transfer_id: 'transfer',
        ok: false,
        reason: 'offline',
      }),
    })
    await h.view.upload('printer', new File(['abc'], 'peca.3mf'))
    expect(h.states.at(-1)?.kind).toBe('error')
    expect(h.files).toEqual([])
  })
  it('sends exactly start_print with the selected file, without retry', async () => {
    const h = harness()
    await h.view.start('peca.gcode')
    expect(h.session.issueControlCommand).toHaveBeenCalledExactlyOnceWith(
      'start_print',
      { file: 'peca.gcode' },
    )
    expect(h.states.at(-1)).toEqual({
      kind: 'done',
      message: 'Impressão iniciada. O Connector confirmou o comando.',
    })
  })
  it('does not connect or send in degraded mode or for a traversal path', async () => {
    const h = harness()
    await h.view.start('../x.gcode')
    h.disable()
    await h.view.start('peca.gcode')
    await h.view.list('printer')
    await h.view.upload('printer', new File(['x'], 'x.gcode'))
    expect(h.connect).not.toHaveBeenCalled()
  })
  it('cancels a pending list and ignores its stale result', async () => {
    let resolve!: (
      value: Awaited<ReturnType<FarmPauseControl['listFiles']>>,
    ) => void
    const h = harness({
      listFiles: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    const pending = h.view.list('printer')
    await Promise.resolve()
    h.view.cancel()
    resolve({
      type: 'files.list.result',
      request_id: 'req',
      printer_key: 'printer',
      ok: true,
      files: [{ name: 'old.gcode', size: 1, modified: 0 }],
    })
    await pending
    expect(h.files).toEqual([])
    expect(h.states.at(-1)?.kind).toBe('cancelled')
    expect(h.session.dispose).toHaveBeenCalled()
  })
  it('blocks duplicate submissions while a session is connecting', async () => {
    const h = harness()
    const pending = h.view.start('peca.gcode')
    const duplicate = h.view.start('peca.gcode')
    await Promise.all([pending, duplicate])
    expect(h.connect).toHaveBeenCalledTimes(1)
  })
})
