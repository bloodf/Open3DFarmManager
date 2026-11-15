import { describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  FarmRow,
  FarmKeyState,
} from '../../apps/farm/app/utils/farm-view.ts'
import type { ControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  controlActionAvailability,
  getPrinterActionButtons,
  actionOutcomeText,
  controlStatusText,
  cancelConfirmationTitle,
  cancelConfirmationDescription,
  actionDialogTitle,
  actionDialogDescription,
  actionButtonConfirmationLabel,
  ACTION_LABELS,
  type Clock,
} from '../../apps/farm/app/utils/farm-control.ts'

const now: Clock = { wall: 100_000, mono: 50_000 }
const keys: FarmKeyState = {
  kind: 'available',
  choices: [{ keyId: 'key-1', thumbprint: 'thumb-1' }],
  selected: 'key-1',
}

function makeRow(
  overrides: Partial<FarmRow> = {},
  stateOverrides: Partial<NonNullable<FarmRow['observation']>['state']> = {},
  age = 1000,
): FarmRow {
  return {
    assignment: {
      assignmentId: randomUUID(),
      agentId: randomUUID(),
      printerKey: 'printer-alpha',
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: 'authenticated',
    localOrigin: null,
    observation: {
      state: {
        printerKey: 'printer-alpha',
        state: 'printing',
        progress: 0.45,
        observedAt: now.wall - age,
        controls: ['pause', 'resume', 'cancel'],
        ...stateOverrides,
      },
      received: { wall: now.wall - age, mono: now.mono - age },
      sourceClockComparable: true,
      historical: false,
    },
    ...overrides,
  }
}

describe('farm-control decision logic: advertised-only buttons', () => {
  test('returns only advertised actions in snapshot controls', () => {
    const row = makeRow({}, { controls: ['pause', 'cancel'] })
    const buttons = getPrinterActionButtons(row, keys, true, false, now)
    expect(buttons.map((b) => b.action)).toEqual(['pause', 'cancel'])
    expect(buttons.map((b) => b.label)).toEqual(['Pausar', 'Cancelar'])
  })

  test('returns empty buttons when snapshot advertises empty controls', () => {
    const row = makeRow({}, { controls: [] })
    const buttons = getPrinterActionButtons(row, keys, true, false, now)
    expect(buttons).toEqual([])
  })

  test('returns all three buttons when all three are advertised', () => {
    const row = makeRow({}, { controls: ['pause', 'resume', 'cancel'] })
    const buttons = getPrinterActionButtons(row, keys, true, false, now)
    expect(buttons.map((b) => b.action)).toEqual(['pause', 'resume', 'cancel'])
    expect(buttons.map((b) => b.label)).toEqual([
      'Pausar',
      'Retomar',
      'Cancelar',
    ])
  })

  test('action availability rejects unadvertised action', () => {
    const row = makeRow({}, { controls: ['pause'] })
    const resumeAvail = controlActionAvailability(
      'resume',
      row,
      keys,
      true,
      now,
    )
    expect(resumeAvail.available).toBe(false)
    if (!resumeAvail.available) {
      expect(resumeAvail.reason).toContain(
        'não é suportada por esta impressora',
      )
    }
  })
})

describe('farm-control decision logic: degraded and in-flight disabling', () => {
  test('disables all buttons when a command is in flight', () => {
    const row = makeRow({}, { controls: ['pause', 'cancel'] })
    const buttons = getPrinterActionButtons(row, keys, true, true, now)
    expect(buttons.every((b) => b.disabled)).toBe(true)
  })

  test('disables buttons when connection is closed (degraded)', () => {
    const row = makeRow(
      { connection: 'closed' },
      { controls: ['pause', 'resume', 'cancel'] },
    )
    const buttons = getPrinterActionButtons(row, keys, true, false, now)
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons.every((b) => !b.available)).toBe(true)
    expect(buttons[0]!.reason).toContain('Não há conexão direta ao vivo.')
  })

  test('disables buttons when connection is unavailable or connecting', () => {
    for (const connection of [
      'unavailable',
      'connecting',
      'verifying',
    ] as const) {
      const row = makeRow({ connection }, { controls: ['pause'] })
      const buttons = getPrinterActionButtons(row, keys, true, false, now)
      expect(buttons[0]!.disabled).toBe(true)
      expect(buttons[0]!.available).toBe(false)
      expect(buttons[0]!.reason).toContain('Não há conexão direta ao vivo.')
    }
  })

  test('disables buttons when observation is historical', () => {
    const row = makeRow()
    row.observation!.historical = true
    const buttons = getPrinterActionButtons(row, keys, true, false, now)
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons[0]!.reason).toContain('Não há conexão direta ao vivo.')
  })

  test('disables buttons when observation is stale', () => {
    const row = makeRow({}, {}, 35_000)
    const buttons = getPrinterActionButtons(row, keys, true, false, now)
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons[0]!.reason).toContain('desatualizado')
  })

  test('disables buttons when control is not enabled on server', () => {
    const row = makeRow()
    const buttons = getPrinterActionButtons(row, keys, false, false, now)
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons[0]!.reason).toContain('não está habilitado')
  })

  test('disables buttons when device key is unavailable or unselected', () => {
    const row = makeRow()
    const noKey: FarmKeyState = { kind: 'loading' }
    const buttons = getPrinterActionButtons(row, noKey, true, false, now)
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons[0]!.reason).toContain('Selecione um dispositivo aprovado')
  })

  test('disables buttons on Anycubic Kobra X read-only device', () => {
    const row = makeRow()
    row.assignment.printerKey = 'kobra-x-' + 'A'.repeat(42) + 'A'
    const buttons = getPrinterActionButtons(row, keys, true, false, now)
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons[0]!.reason).toContain('operam somente em leitura')
  })

  test('respects state compatibility for pause, resume, and cancel', () => {
    // When printing: pause is available, cancel is available, resume is not available
    const printingRow = makeRow(
      {},
      { state: 'printing', controls: ['pause', 'resume', 'cancel'] },
    )
    const printingButtons = getPrinterActionButtons(
      printingRow,
      keys,
      true,
      false,
      now,
    )
    const pauseBtn = printingButtons.find((b) => b.action === 'pause')!
    const resumeBtn = printingButtons.find((b) => b.action === 'resume')!
    const cancelBtn = printingButtons.find((b) => b.action === 'cancel')!

    expect(pauseBtn.available).toBe(true)
    expect(pauseBtn.disabled).toBe(false)
    expect(cancelBtn.available).toBe(true)
    expect(cancelBtn.disabled).toBe(false)
    expect(resumeBtn.available).toBe(false)
    expect(resumeBtn.disabled).toBe(true)
    expect(resumeBtn.reason).toContain('A impressão não está pausada.')

    // When paused: pause is not available, resume is available, cancel is available
    const pausedRow = makeRow(
      {},
      { state: 'paused', controls: ['pause', 'resume', 'cancel'] },
    )
    const pausedButtons = getPrinterActionButtons(
      pausedRow,
      keys,
      true,
      false,
      now,
    )
    const pauseBtn2 = pausedButtons.find((b) => b.action === 'pause')!
    const resumeBtn2 = pausedButtons.find((b) => b.action === 'resume')!
    const cancelBtn2 = pausedButtons.find((b) => b.action === 'cancel')!

    expect(pauseBtn2.available).toBe(false)
    expect(pauseBtn2.disabled).toBe(true)
    expect(pauseBtn2.reason).toContain('A impressora não está imprimindo.')
    expect(resumeBtn2.available).toBe(true)
    expect(resumeBtn2.disabled).toBe(false)
    expect(cancelBtn2.available).toBe(true)
    expect(cancelBtn2.disabled).toBe(false)

    // When idle: none of pause, resume, cancel are available
    const idleRow = makeRow(
      {},
      { state: 'idle', controls: ['pause', 'resume', 'cancel'] },
    )
    const idleButtons = getPrinterActionButtons(idleRow, keys, true, false, now)
    expect(idleButtons.every((b) => !b.available && b.disabled)).toBe(true)
  })
})

describe('cancel confirmation dialog specification', () => {
  test('cancel confirmation dialog explicitly names the printer in title and description', () => {
    const printerName = 'Voron 2.4 #3'
    const title = cancelConfirmationTitle(printerName)
    const desc = cancelConfirmationDescription(printerName)

    expect(title).toBe('Cancelar impressão de Voron 2.4 #3')
    expect(desc).toContain(
      'A impressora Voron 2.4 #3 vai cancelar a impressão atual.',
    )
    expect(desc).toContain('Esta ação não pode ser desfeita.')
    expect(desc).toContain('nunca é repetido automaticamente.')
  })

  test('actionDialogTitle and actionDialogDescription handle all actions', () => {
    const printerName = 'Ender-3 V3'
    expect(actionDialogTitle('pause', printerName)).toBe(
      'Pausar impressão de Ender-3 V3',
    )
    expect(actionDialogTitle('resume', printerName)).toBe(
      'Retomar impressão de Ender-3 V3',
    )
    expect(actionDialogTitle('cancel', printerName)).toBe(
      'Cancelar impressão de Ender-3 V3',
    )

    expect(actionDialogDescription('pause', printerName)).toContain(
      'pausar a impressão atual',
    )
    expect(actionDialogDescription('resume', printerName)).toContain(
      'retomar a impressão atual',
    )
    expect(actionDialogDescription('cancel', printerName)).toContain(
      'Ender-3 V3',
    )

    expect(actionButtonConfirmationLabel('pause')).toBe('Confirmar pausa')
    expect(actionButtonConfirmationLabel('resume')).toBe('Confirmar retomada')
    expect(actionButtonConfirmationLabel('cancel')).toBe(
      'Confirmar cancelamento',
    )
  })
})

describe('result messages and status copy', () => {
  test('outcome messages for pause, resume, cancel across all outcomes', () => {
    const actions: ControlAction[] = ['pause', 'resume', 'cancel']
    for (const action of actions) {
      expect(actionOutcomeText(action, 'applied')).toContain('confirmou')
      expect(actionOutcomeText(action, 'rejected')).toContain(
        'Comando recusado.',
      )
      expect(actionOutcomeText(action, 'rejected')).toContain(
        'nada será repetido automaticamente.',
      )
      expect(actionOutcomeText(action, 'not-sent')).toContain(
        'não foi enviado à impressora',
      )
      expect(actionOutcomeText(action, 'outcome-unknown')).toContain(
        'Não foi possível confirmar',
      )
    }

    // Exact compatibility with existing pause text
    expect(actionOutcomeText('pause', 'applied')).toBe(
      'Impressão pausada. O Connector confirmou a pausa.',
    )
    expect(actionOutcomeText('pause', 'rejected')).toBe(
      'Comando recusado. A impressora não foi pausada e nada será repetido automaticamente.',
    )
  })

  test('controlStatusText reflects states and remaining seconds', () => {
    expect(controlStatusText('cancel', { kind: 'connecting' }, 10)).toBe(
      'Preparando conexão e autorização seguras…',
    )
    expect(
      controlStatusText('cancel', { kind: 'ready', expiresAt: 120_000 }, 25),
    ).toBe('Autorização pronta. Confirme em até 25 s.')
    expect(controlStatusText('cancel', { kind: 'sending' }, 0)).toBe(
      'Enviando o comando de cancelar…',
    )
    expect(controlStatusText('resume', { kind: 'sending' }, 0)).toBe(
      'Enviando o comando de retomar…',
    )
    expect(controlStatusText('pause', { kind: 'sending' }, 0)).toBe(
      'Enviando o comando de pausar…',
    )
    expect(
      controlStatusText('cancel', { kind: 'settled', outcome: 'applied' }, 0),
    ).toBe('Impressão cancelada. O Connector confirmou o cancelamento.')
    expect(
      controlStatusText('cancel', { kind: 'failed', reason: 'unavailable' }, 0),
    ).toContain('Não foi possível obter uma autorização segura.')
    expect(
      controlStatusText('cancel', { kind: 'failed', reason: 'not-ready' }, 0),
    ).toContain('A autorização não ficou pronta.')
    expect(
      controlStatusText('cancel', { kind: 'failed', reason: 'expired' }, 0),
    ).toContain('A autorização expirou antes da confirmação.')
    expect(
      controlStatusText('cancel', { kind: 'failed', reason: 'closed' }, 0),
    ).toContain('A conexão segura foi encerrada.')
  })
})
