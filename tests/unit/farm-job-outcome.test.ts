import { describe, expect, it } from 'vitest'
import { farmJobOutcome } from '../../apps/farm/app/utils/farm-job-outcome.ts'

describe('farm job outcome', () => {
  it.each([
    ['completed', 'Concluído'],
    ['cancelled', 'Cancelado'],
    ['failed', 'Falhou'],
  ] as const)('shows %s', (outcome, label) => {
    const state = {
      printerKey: 'p',
      state: 'idle' as const,
      observedAt: 0,
      progress: 0,
      lastJob: {
        outcome,
        filename: 'part.gcode',
        endedAt: 0,
        printDuration: 120,
      },
    }
    expect(farmJobOutcome(state)).toEqual({
      label,
      filename: 'part.gcode',
      endedAt: new Date(0).toLocaleString('pt-BR'),
      duration: '0 h 2 min',
    })
    expect(farmJobOutcome({ ...state, state: 'printing' })).toBeUndefined()
  })
})
