import type { KobraXFacts, KobraXFactsTracker } from './facts.ts'
import type { KobraXReport } from './requests.ts'

export interface KobraXSlotUsage {
  /** ACE slot index. */
  slot: number
  grams: number
  materialType?: string
  colorHex?: string
}

export interface KobraXJobUsage {
  /** Stable per job, for booking once. */
  jobKey: string
  filename?: string
  outcome: 'completed' | 'cancelled' | 'failed'
  endedAt: number
  slots: readonly KobraXSlotUsage[]
}

type Baseline = Map<number, number>

function remainingGrams(facts: KobraXFacts): Baseline {
  const grams: Baseline = new Map()
  for (const slot of facts.boxes[0]?.slots ?? []) {
    if (slot.remainingPercent !== undefined && slot.weightGrams !== undefined)
      grams.set(slot.index, (slot.remainingPercent / 100) * slot.weightGrams)
  }
  return grams
}

/**
 * Filament used per ACE slot, measured as the drop in the reported remaining
 * material between the start and the end of a job. Resolution is the ACE
 * percentage step. A job already running when the Connector connected has no
 * baseline and reports no usage rather than a guess.
 */
export function createKobraXUsage(input: {
  facts: KobraXFactsTracker
  onUsage(usage: KobraXJobUsage): void
  /** Waits for the final ACE report after the job ends. */
  settleMs?: number
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const settleMs = input.settleMs ?? 1000
  let baseline: Baseline | undefined
  let startedAt = 0
  let filename: string | undefined
  let pending: NodeJS.Timeout | undefined
  const unsubscribe = input.facts.subscribe((next, previous) => {
    if (!previous.jobActive && next.jobActive) {
      baseline = remainingGrams(next)
      startedAt = now()
      filename = next.filename
    } else if (next.jobActive && next.filename) filename = next.filename
  })

  function finish(outcome: KobraXJobUsage['outcome'], endedAt: number) {
    const start = baseline
    const key = `${filename ?? 'job'}:${startedAt}`
    const name = filename
    baseline = undefined
    if (!start) return
    const emit = () => {
      const facts = input.facts.get()
      const end = remainingGrams(facts)
      const slots: KobraXSlotUsage[] = []
      for (const [slot, before] of start) {
        const after = end.get(slot)
        if (after === undefined) continue
        const grams = Math.round((before - after) * 10) / 10
        if (grams <= 0) continue
        const detail = facts.boxes[0]?.slots.find((s) => s.index === slot)
        slots.push({
          slot,
          grams,
          ...(detail?.materialType
            ? { materialType: detail.materialType }
            : {}),
          ...(detail?.colorHex ? { colorHex: detail.colorHex } : {}),
        })
      }
      input.onUsage({
        jobKey: key,
        ...(name ? { filename: name } : {}),
        outcome,
        endedAt,
        slots,
      })
    }
    if (settleMs > 0) pending = setTimeout(emit, settleMs)
    else emit()
  }

  return {
    report(report: KobraXReport) {
      if (report.type !== 'print') return
      if (report.state === 'finished') finish('completed', now())
      else if (report.state === 'stoped')
        finish(
          report.code === undefined || report.code === 0 || report.code === 200
            ? 'cancelled'
            : 'failed',
          now(),
        )
    },
    close() {
      unsubscribe()
      clearTimeout(pending)
    },
  }
}
export type KobraXUsageTracker = ReturnType<typeof createKobraXUsage>
