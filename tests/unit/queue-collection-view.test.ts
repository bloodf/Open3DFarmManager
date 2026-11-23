// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/web_api/#job-queue-apis
import { describe, expect, it } from 'vitest'
import { collectionHoldView } from '../../apps/farm/app/components/farm/collection-hold-view.ts'
import type { FarmRow } from '../../apps/farm/app/utils/farm-view.ts'

function row(controls: string[] | undefined, endedAt?: number): FarmRow {
  return {
    observation: {
      state: {
        ...(controls ? { controls } : {}),
        ...(endedAt !== undefined
          ? { lastJob: { outcome: 'completed', endedAt } }
          : {}),
      },
    },
  } as unknown as FarmRow
}

describe('collection hold view', () => {
  it('shows the hold only while the Connector advertises it', () => {
    expect(collectionHoldView(row(['pause'], 5)).awaiting).toBe(false)
    const view = collectionHoldView(row(['confirm_collection'], 5000))
    expect(view).toMatchObject({ awaiting: true, attempt: '5000' })
    expect(view.status).toMatch(/^Aguardando retirada\./)
    expect(collectionHoldView(row(['confirm_collection'])).attempt).toBe(
      undefined,
    )
    expect(collectionHoldView(row(undefined)).awaiting).toBe(false)
  })
  it('warns that the Moonraker native queue cannot be held', () => {
    expect(collectionHoldView(row(['queue_op'])).nativeQueueWarning).toBe(true)
    expect(collectionHoldView(row(['pause'])).nativeQueueWarning).toBe(false)
  })
})
