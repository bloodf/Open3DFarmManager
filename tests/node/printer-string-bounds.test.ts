import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { decodeCrealityStatus } from '../../packages/connector/src/creality/index.ts'
import { createKobraXStatus } from '../../packages/connector/src/kobra-x/status.ts'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import { moonrakerLastJob } from '../../packages/connector/src/moonraker/normalize.ts'
import {
  parseBoundedJson,
  TELEMETRY_BATCH_JSON_LIMITS,
  TelemetryBatch,
  PrinterState,
} from '@open3dfarmmanager/farm-protocol'

type FilenameFields = Pick<PrinterState, 'filename' | 'lastJob'>
const observedAt = Date.now()

const parsers: Record<
  string,
  (filename: string) => FilenameFields | Promise<FilenameFields>
> = {
  Anycubic(filename) {
    const report = decodeAnycubicReport(
      Buffer.from(
        JSON.stringify({
          data: {
            state: 'busy',
            project: { state: 'printing', progress: 50, filename },
          },
        }),
      ),
    )
    assert.equal(report.kind, 'observation')
    assert.ok('filename' in report && typeof report.filename === 'string')
    return { filename: report.filename }
  },
  'Kobra X'(filename) {
    const status = createKobraXStatus('printer', '127.0.0.1')
    status.report('print', {
      state: 'printing',
      data: { filename, progress: 50 },
    })
    status.report('print', { state: 'finished', data: {} })
    return status.snapshot()
  },
  async KobraLink(filename) {
    const origin = 'http://127.0.0.1:8080'
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      fetch: async (url) => {
        if (url === origin + '/api/auth/sign-in/email')
          return new Response(null, {
            headers: {
              'set-cookie': 'better-auth.session_token=synthetic; HttpOnly',
            },
          })
        assert.equal(url, origin + '/api/v1/printers/printer')
        return Response.json({
          id: 'printer',
          deviceId: 'device',
          name: 'fixture',
          live: {
            connected: true,
            updatedAt: Date.now(),
            kobraState: 'finished',
            printState: 'complete',
            progress: 1,
            filename,
          },
        })
      },
    })
    await client.authenticate({
      ownership: 'fresh_owned',
      mode: 'signin',
      name: 'fixture',
      email: 'fixture@example.test',
      password: 'synthetic',
    })
    return client.getPrinterObservation({ id: 'printer', deviceId: 'device' })
  },
  Moonraker(filename) {
    const status = {
      webhooks: { state: 'ready' },
      print_stats: { state: 'printing', filename },
      virtual_sdcard: { progress: 0.5, is_active: true },
    }
    const { printer } = parseMoonrakerSnapshot(
      JSON.stringify({ result: { eventtime: 42, status } }),
      { printerKey: 'printer', observedAt },
    )
    const lastJob = moonrakerLastJob(
      { ...status, print_stats: { state: 'complete', filename } },
      observedAt,
    )
    assert.ok(lastJob)
    return { ...printer, lastJob }
  },
  Bambu(filename) {
    const report = decodeBambuReport(
      JSON.stringify({
        print: {
          gcode_state: 'RUNNING',
          mc_percent: 50,
          subtask_name: filename,
        },
      }),
    )
    assert.equal(report.kind, 'observation')
    assert.ok(typeof report.filename === 'string')
    return { filename: report.filename }
  },
  Creality(filename) {
    const report = decodeCrealityStatus(
      JSON.stringify({ state: 1, printProgress: 50, printFileName: filename }),
    )
    assert.ok(report?.filename)
    return { filename: report.filename }
  },
}

for (const [vendor, parse] of Object.entries(parsers)) {
  test(`${vendor} bounds printer filenames and delivers them ahead of later telemetry`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfarm-printer-bounds-'))
    const queue = new TelemetryQueue(directory, observedAt)
    try {
      // The second astral character straddles the wire limit in UTF-16.
      const prefix = 'é'.repeat(125) + '🚀'
      const filename = prefix + '🌍'.repeat(36) + '.gcode'
      assert.ok(filename.length >= 129 && filename.length <= 255)
      const parsed = await parse(filename)
      const first = queue.enqueue(
        {
          printerKey: 'printer',
          state: 'printing',
          progress: 0.5,
          observedAt,
          ...(parsed.filename !== undefined
            ? { filename: parsed.filename }
            : {}),
          ...(parsed.lastJob ? { lastJob: parsed.lastJob } : {}),
        },
        observedAt,
      )
      const later = queue.enqueue(
        {
          printerKey: 'later',
          state: 'idle',
          progress: 0,
          observedAt,
        },
        observedAt,
      )
      const sent: Array<{
        id: string
        filename?: string
        lastFilename?: string
      }> = []
      const result = await drainTelemetryOnce(
        queue,
        async (body) => {
          const batch = TelemetryBatch.parse(
            parseBoundedJson(body, TELEMETRY_BATCH_JSON_LIMITS),
          )
          for (const entry of batch) {
            assert.equal(entry.kind, 'printer-state')
            const { eventId, state: printerState } = entry
            sent.push({
              id: eventId,
              ...(printerState?.filename !== undefined
                ? { filename: printerState.filename }
                : {}),
              ...(printerState?.lastJob?.filename !== undefined
                ? { lastFilename: printerState.lastJob.filename }
                : {}),
            })
          }
          return batch.map(({ eventId }) => eventId)
        },
        () => observedAt,
        new AbortController().signal,
      )
      assert.equal(result.status, 'delivered')
      assert.deepEqual(sent, [
        {
          id: first.eventId,
          ...(vendor === 'KobraLink' ? {} : { filename: prefix }),
          ...(['Kobra X', 'KobraLink', 'Moonraker'].includes(vendor)
            ? { lastFilename: prefix }
            : {}),
        },
        { id: later.eventId },
      ])
      assert.equal(queue.depth, 0)
    } finally {
      queue.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test('state and telemetry agree on the filename length and Unicode boundary', () => {
  const filename = 'é'.repeat(126) + '🚀'
  const state = {
    printerKey: 'printer',
    state: 'idle',
    progress: 0,
    observedAt,
    filename,
    lastJob: { outcome: 'completed', endedAt: observedAt, filename },
  }
  const accepted = PrinterState.parse(state)
  const batch = [
    {
      kind: 'printer-state',
      eventId: '74e94848-1f73-4ffe-9d5b-8bc14f672b0a',
      queuedAt: observedAt,
      state: accepted,
    },
  ]
  assert.deepEqual(
    TelemetryBatch.parse(
      parseBoundedJson(JSON.stringify(batch), TELEMETRY_BATCH_JSON_LIMITS),
    ),
    batch,
  )
  for (const invalid of [filename + 'x', '\uD800']) {
    assert.equal(
      PrinterState.safeParse({ ...state, filename: invalid }).success,
      false,
    )
    assert.equal(
      PrinterState.safeParse({
        ...state,
        lastJob: { ...state.lastJob, filename: invalid },
      }).success,
      false,
    )
  }
})
