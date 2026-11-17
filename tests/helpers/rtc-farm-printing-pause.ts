import assert from 'node:assert/strict'

export const PAUSED_UI = 'Impressão pausada. O Connector confirmou a pausa.'
export type PauseEvidence = {
  klipper: string
  ui: string
  journal: readonly { cmd_id: string; status: string; reason: string | null }[]
}

/** A single confirmation, including when its response is lost. Only reads poll. */
export async function runPrintingPause(input: {
  start(): Promise<void>
  confirm(): Promise<void>
  observe(): Promise<PauseEvidence>
  resume(): Promise<void>
  resumed(): Promise<void>
  note(value: string): Promise<void>
}) {
  await input.start()
  // Deliberately outside any retry/polling loop. On uncertainty retain evidence
  // and fail without resuming or resending. The caller cleans up its print.
  try {
    await input.confirm()
  } catch (error) {
    await input.note(
      'farm-page-printing-pause-confirmation-error:' +
        (error instanceof Error ? error.message.slice(0, 4000) : 'unknown'),
    )
    // Best-effort diagnostic read, never a second send or a success result.
    try {
      await input.note(
        'farm-page-printing-pause-uncertain:' +
          JSON.stringify(await input.observe()),
      )
    } catch {
      await input.note(
        'farm-page-printing-pause-uncertain:evidence-unavailable',
      )
    }
    throw error
  }
  const evidence = await input.observe()
  await input.note(
    'farm-page-printing-pause-outcome:' + JSON.stringify(evidence),
  )
  assert.equal(evidence.klipper, 'paused')
  assert.equal(evidence.ui, PAUSED_UI)
  assert.equal(evidence.journal.length, 1, 'Exactly one journal command')
  const entry = evidence.journal[0]!
  assert.ok(entry.cmd_id)
  assert.equal(entry.status, 'applied')
  assert.equal(entry.reason, 'applied')
  await input.resume()
  await input.resumed()
  // Detect delayed duplicates after resume as well as at the initial result.
  const after = await input.observe()
  assert.equal(after.klipper, 'printing')
  assert.deepEqual(after.journal, evidence.journal)
  await input.note('farm-page-printing-pause-agreement-no-retry-resumed')
}
