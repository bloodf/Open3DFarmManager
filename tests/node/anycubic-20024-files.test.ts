// SPDX-License-Identifier: AGPL-3.0-or-later
// Model 20024 (Kobra 3) file listing and upload against the loopback simulator.
// Synthetic, reference-derived wire (nothing here was captured, no printer is
// contacted):
// - rvanderp3/kobra-connect@3edba24606d7122c4a68accd09af937ba4fdbd08
//   docs/mqtt-commands.md §13 and §16 (model 20024 topics, upload URL).
// - bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
//   docs/protocol.md "Files on the printer", src/kobracontrol/kobra.py
//   (`LIST_DATA`, `_file_records`, `_seconds`, `succeeded`, `_upload`) and
//   tests/test_kobra.py (refusal codes 10112 and 10203).
import assert from 'node:assert/strict'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  listAnycubicFiles,
  uploadAnycubicFile,
} from '../../packages/connector/src/anycubic/files.ts'
import { provisionAnycubicPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'

const name = 'journey.gcode.3mf'
const filePath = fileURLToPath(
  new URL(`../fixtures/anycubic/${name}`, import.meta.url),
)

async function fixture(
  t: TestContext,
  options: {
    listReply?: { state: string; code: number }
    uploadCode?: number
    modelId?: string
  } = {},
) {
  const { modelId = '20024', ...replies } = options
  const directory = await mkdtemp(join(tmpdir(), 'anycubic-20024-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const passwordFile = join(directory, 'password.json')
  await writeFile(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const sim = await startAnycubicSimulator({
    serial: `${modelId}/device`,
    lanFiles: { firmware: '2.4.6.7', ...replies },
    credentials: { username: 'synthetic', password: 'synthetic' },
  })
  t.after(() => sim.close())
  const binding = provisionAnycubicPrinter(
    {
      assignment_id: randomUUID(),
      printer_key: 'printer',
      farm_id: randomUUID(),
      agent_id: randomUUID(),
    },
    {
      printerKey: 'printer',
      host: sim.host,
      port: sim.port,
      uploadPort: sim.uploadPort,
      modelId,
      deviceId: 'device',
      username: 'synthetic',
      passwordFile,
      pinSha256: createHash('sha256')
        .update(new X509Certificate(sim.syntheticTrust).raw)
        .digest('hex'),
    },
  )
  const input = {
    binding,
    signal: AbortSignal.timeout(8000),
    authorized: () => true,
  }
  return { sim, input, upload: { ...input, filePath, name } }
}

test('an uploaded package is listed in seconds and the printer directory is hidden', async (t) => {
  const { sim, input, upload } = await fixture(t)
  assert.deepEqual(await listAnycubicFiles(input), [])
  const before = Math.floor(Date.now() / 1000)
  await uploadAnycubicFile(upload)
  assert.equal(sim.uploadCount, 1)
  const files = await listAnycubicFiles(input)
  assert.equal(files.length, 1)
  const [file] = files
  assert.equal(file!.name, name)
  assert.equal(file!.size, (await stat(filePath)).size)
  assert.equal(file!.printUnsupported, true)
  // The wire carries milliseconds; `PrinterFile.modified` is in seconds.
  assert.ok(file!.modified >= before && file!.modified < before + 60)
})

test('a "success" list reply is a result', async (t) => {
  const { sim, input } = await fixture(t, {
    listReply: { state: 'success', code: 200 },
  })
  sim.upload('part.gcode', Buffer.from('G28\n'))
  assert.deepEqual(
    (await listAnycubicFiles(input)).map((file) => file.name),
    ['part.gcode'],
  )
})

test('a refused list is an error, not an empty storage', async (t) => {
  const { input } = await fixture(t, {
    listReply: { state: 'failed', code: 10112 },
  })
  await assert.rejects(listAnycubicFiles(input), { message: 'offline' })
})

test('an upload refused with HTTP 200 is not reported as stored', async (t) => {
  const { sim, input, upload } = await fixture(t, { uploadCode: 10203 })
  await assert.rejects(uploadAnycubicFile(upload), { message: 'offline' })
  assert.equal(sim.uploadCount, 0)
  assert.deepEqual(await listAnycubicFiles(input), [])
})

test('a sibling model code stays gated', async (t) => {
  const { sim, input, upload } = await fixture(t, { modelId: '20027' })
  await assert.rejects(listAnycubicFiles(input), { message: 'unsupported' })
  await assert.rejects(uploadAnycubicFile(upload), { message: 'unsupported' })
  assert.equal(sim.uploadCount, 0)
})
