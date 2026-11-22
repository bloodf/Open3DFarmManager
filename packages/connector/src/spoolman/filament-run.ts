import { createHash } from 'node:crypto'
import type { FilamentUsage } from '@open3dfarmmanager/farm-protocol'
import type {
  FilamentRunEntry,
  FilamentRunJournal,
} from '../control/filament-run-journal.ts'
import { SpoolmanConfig } from './config.ts'

/** The spool a tool was loaded with, and who tracks its usage. */
export interface ActiveSpoolRef {
  tool: string
  spoolId: number
  /** `moonraker`: Moonraker's `[spoolman]` already reports usage. `assignment`: OpenFarm's own assignment. */
  source: 'moonraker' | 'assignment'
}
export interface RunCompletion {
  printerKey: string
  /** Stable run id (e.g. the printer's job id) when one exists; otherwise the end time identifies the attempt. */
  runId?: string
  endedAt: number
  outcome: 'completed' | 'cancelled' | 'failed'
  /** Measured usage only. Absent or without a quantity means unknown. */
  usage?: readonly FilamentUsage[] | undefined
  /** Spools loaded when the run started and when it ended. A change in between makes attribution unknown. */
  spoolsAtStart: readonly ActiveSpoolRef[]
  spoolsAtEnd: readonly ActiveSpoolRef[]
}
export interface FilamentRunOutcome {
  key: string
  tool: string
  spoolId: number | null
  status: FilamentRunEntry['status']
  reason: string | null
  /** True when this event matched an existing entry and changed nothing. */
  duplicate: boolean
}

/** Idempotency key of one run attempt and tool. */
export function filamentRunKey(
  run: Pick<RunCompletion, 'printerKey' | 'runId' | 'endedAt'>,
  tool: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        run.printerKey,
        run.runId ?? `ended:${run.endedAt}`,
        tool,
      ]),
    )
    .digest('hex')
}

type Amount = { grams: number } | { millimetres: number }
function amountOf(usage: FilamentUsage): Amount | undefined {
  if (usage.grams !== undefined && usage.grams > 0)
    return { grams: usage.grams }
  if (usage.millimetres !== undefined && usage.millimetres > 0)
    return { millimetres: usage.millimetres }
  return undefined
}

/**
 * Applies a finished run to Spoolman at most once per run attempt and tool.
 * Usage is never synthesised: no measured quantity, an unresolved tool, a
 * spool change mid-run or a run that did not complete record `unknown`.
 */
export function createFilamentRunAccounting(input: {
  journal: FilamentRunJournal
  origin: string
  /** Authorization header value; never logged. */
  authorization?: string
  timeoutMs?: number
  fetch?: typeof fetch
}) {
  const origin = SpoolmanConfig.shape.origin.parse(input.origin)
  const request = input.fetch ?? fetch
  const timeoutMs = input.timeoutMs ?? 10_000
  const { journal } = input

  /** Sends one debit. Anything but a definite answer is `uncertain`, never retried. */
  async function debit(
    entry: FilamentRunEntry,
    amount: Amount,
    signal: AbortSignal | undefined,
  ) {
    let response: Response
    try {
      response = await request(
        new URL(`/api/v1/spool/${entry.spoolId}/use`, origin),
        {
          method: 'PUT',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(input.authorization
              ? { authorization: input.authorization }
              : {}),
          },
          body: JSON.stringify(
            'grams' in amount
              ? { use_weight: amount.grams }
              : { use_length: amount.millimetres },
          ),
        },
      )
    } catch {
      return journal.finish(entry.key, 'uncertain', 'response-lost')
    }
    // Release the body; its content is not needed and must not be trusted.
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 200) return journal.finish(entry.key, 'applied')
    // Definite refusals: Spoolman did not apply the use.
    if ([400, 401, 403, 404, 422].includes(response.status))
      return journal.finish(entry.key, 'rejected', `http-${response.status}`)
    return journal.finish(entry.key, 'uncertain', `http-${response.status}`)
  }

  async function recordOne(
    run: RunCompletion,
    usage: FilamentUsage | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FilamentRunOutcome> {
    const tool = usage?.tool ?? 'unknown'
    const key = filamentRunKey(run, tool)
    const start = run.spoolsAtStart.find((spool) => spool.tool === tool)
    const end = run.spoolsAtEnd.find((spool) => spool.tool === tool)
    const amount = usage ? amountOf(usage) : undefined
    let status: 'pending' | 'unknown' | 'record-only' = 'unknown'
    let reason: string | null
    if (run.outcome !== 'completed') reason = 'run-not-completed'
    else if (!usage) reason = 'usage-missing'
    else if (tool === 'unknown') reason = 'tool-unresolved'
    else if (!start) reason = 'no-active-spool'
    else if (end?.spoolId !== start.spoolId) reason = 'spool-changed'
    else if (!amount) reason = 'usage-missing'
    else if (start.source === 'moonraker' && end.source === 'moonraker') {
      status = 'record-only'
      reason = 'moonraker-reports'
    } else {
      status = 'pending'
      reason = null
    }
    const claim = journal.claim({
      key,
      printerKey: run.printerKey,
      tool,
      spoolId: start?.spoolId ?? null,
      status,
      reason,
      grams: amount && 'grams' in amount ? amount.grams : null,
      millimetres:
        amount && 'millimetres' in amount ? amount.millimetres : null,
    })
    const done = (entry: FilamentRunEntry, duplicate: boolean) => ({
      key: entry.key,
      tool: entry.tool,
      spoolId: entry.spoolId,
      status: entry.status,
      reason: entry.reason,
      duplicate,
    })
    if (!claim.claimed) return done(claim.entry, true)
    if (status !== 'pending' || !amount) return done(claim.entry, false)
    return done(await debit(claim.entry, amount, signal), false)
  }

  return {
    /** Idempotent: repeated or out-of-order events for the same run attempt debit at most once. */
    async completeRun(
      run: RunCompletion,
      signal?: AbortSignal,
    ): Promise<FilamentRunOutcome[]> {
      const entries = run.usage?.length ? run.usage : [undefined]
      // An earlier event without usage left a placeholder; real usage supersedes it.
      if (run.usage?.length) {
        const placeholder = journal.get(filamentRunKey(run, 'unknown'))
        if (
          placeholder?.status === 'unknown' &&
          placeholder.reason === 'usage-missing' &&
          run.usage.some((usage) => usage.tool !== 'unknown')
        )
          journal.finish(placeholder.key, 'unknown', 'superseded')
      }
      const outcomes: FilamentRunOutcome[] = []
      // Sequential: each claim is journaled before its call.
      for (const usage of entries)
        outcomes.push(await recordOne(run, usage, signal))
      return outcomes
    },
    /** Entries needing operator reconciliation. */
    uncertain: () => journal.list('uncertain'),
  }
}
export type FilamentRunAccounting = ReturnType<
  typeof createFilamentRunAccounting
>
