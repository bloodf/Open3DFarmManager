// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { createReplayOutcomeLocks } from '../../apps/farm/app/utils/replay-outcome'

describe('replay outcome locks', () => {
  it('keeps an unknown outcome locked when the dialog is reopened', () => {
    const locks = createReplayOutcomeLocks()

    locks.record('library-item-1', { outcome: 'outcome-unknown' })

    expect(locks.get('library-item-1')).toEqual({
      outcome: 'outcome-unknown',
    })
  })

  it('keeps locks separate by library item', () => {
    const locks = createReplayOutcomeLocks()
    locks.record('library-item-1', { outcome: 'outcome-unknown' })

    expect(locks.get('library-item-2')).toBeNull()
  })

  it('clears an unknown outcome only when resolved or explicitly checked', () => {
    const locks = createReplayOutcomeLocks()
    locks.record('library-item-1', { outcome: 'outcome-unknown' })
    locks.record('library-item-1', { outcome: 'applied' })

    expect(locks.get('library-item-1')).toBeNull()

    locks.record('library-item-1', { outcome: 'outcome-unknown' })
    locks.confirmPrinterChecked('library-item-1')

    expect(locks.get('library-item-1')).toBeNull()
  })
})
