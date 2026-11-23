// spec-derived, not captured — https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { ApiQueryResult } from '../../packages/farm-protocol/src/api-query.ts'
import {
  answerApiQuery,
  readDispatchObservation,
} from '../../packages/connector/src/runtime/api-query.ts'
import { moonrakerQueryClient } from '../../packages/connector/src/runtime/api-query-moonraker.ts'
import {
  confirmCollection,
  observeDispatch,
  observeFinishedRun,
  type CollectionState,
} from '../../packages/connector/src/control/queue-collection.ts'

test('dispatch observations preserve the attempt across repeated confirmations and withhold clearance during a competing run', async () => {
  const mock = await startMoonrakerMock({ initial: { state: 'standby' } })
  const ledger = process.env.MOONRAKER_TEST_LEDGER
  if (ledger) appendFileSync(ledger, `created ${mock.origin}\n`)
  try {
    let collection: CollectionState = { attempts: [] }
    const client = moonrakerQueryClient(mock.origin, {
      maxMessageBytes: 4096,
      requestTimeoutMs: 1000,
      connectTimeoutMs: 1000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
      staleAfterMs: 1000,
    })
    const query = async () => {
      const result = await answerApiQuery(
        {
          v: 1,
          t: 'connector.api-query',
          request_id: randomUUID(),
          assignment_id: randomUUID(),
          kind: 'dispatch',
          offset: 0,
          limit: 1,
        },
        async () => ({
          dispatch: await readDispatchObservation(
            () => client.request('printer.objects.query.dispatch'),
            () => collection,
          ),
        }),
        AbortSignal.timeout(3000),
      )
      const decoded = ApiQueryResult.parse(JSON.parse(result.wire))
      expect(decoded.kind).toBe('dispatch')
      if (decoded.kind !== 'dispatch')
        throw Error('Expected dispatch observation')
      return decoded.data[0]
    }

    expect(await query()).toMatchObject({
      printerState: 'idle',
      plateState: 'unknown',
      attemptId: '0',
    })
    collection = observeDispatch(collection, 100)
    mock.control.completePrint()
    collection = observeFinishedRun(collection, 200)
    expect(await query()).toMatchObject({
      plateState: 'awaiting-collection',
      attemptId: '200',
    })
    collection = confirmCollection(confirmCollection(collection, '200'), '200')
    expect(await query()).toMatchObject({
      plateState: 'operator-confirmed',
      attemptId: '200',
    })
    collection = observeDispatch(collection, 300)
    expect(await query()).toMatchObject({
      printerState: 'idle',
      plateState: 'unknown',
    })
    mock.control.update({ state: 'printing' })
    expect(await query()).toMatchObject({
      printerState: 'busy',
      plateState: 'unknown',
    })
  } finally {
    await mock.close()
    if (ledger) appendFileSync(ledger, `removed ${mock.origin}\n`)
  }
})
