import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'

vi.mock(
  '../../packages/connector/src/runtime/job-file-fetch.ts',
  async (original) => {
    const actual =
      await original<
        typeof import('../../packages/connector/src/runtime/job-file-fetch.ts')
      >()
    return {
      ...actual,
      async fetchJobFile(input: {
        authorize(): boolean
        start(name: string): Promise<unknown>
      }) {
        if (!input.authorize()) throw new Error('unauthorized')
        await input.start('part.gcode')
      },
    }
  },
)

async function runStart(kind: 'library' | 'file', ready: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'library-readiness-'))
  const wall = Date.now()
  const journal = openCommandJournal({ directory, clock: () => wall })
  try {
    const pair = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const farmId = randomUUID()
    const agentId = randomUUID()
    const appId = randomUUID()
    const grantId = randomUUID()
    const assignmentId = randomUUID()
    const origin = 'http://127.0.0.1:7125'
    const registry = createPrinterBindingRegistry({ allowedOrigins: [origin] })
    const binding = registry.provision({
      assignment_id: assignmentId,
      farm_id: farmId,
      agent_id: agentId,
      printer_key: 'mock',
      moonraker_origin: origin,
    })
    let observed: { ready: boolean; printState: string } | null = null
    const prepare = vi.fn(async () => {
      observed = { ready, printState: 'idle' }
      return { connectionGeneration: 1 }
    })
    const send = vi.fn()
    const runner = createApiCommandRunner({
      farmId,
      agentId,
      journal,
      report() {},
      keys: { issuer: () => pair.publicKey },
      grants: {
        lookup: () => ({
          grant_id: grantId,
          app_id: appId,
          farm_id: farmId,
          scopes: ['jobs:start', 'jobs:write'],
          revoked: false,
        }),
        freshness: { freshAt: () => true },
      },
      printer: () => binding,
      observe: () => observed,
      clock: { wallNow: () => wall, monotonicNow: () => 1000 },
      jobFiles: {
        directory,
        targetFor: () => ({ backend: 'moonraker', origin }),
      },
      libraryPrint: {
        async start(input) {
          if (!input.authorize()) throw new Error('unauthorized')
          await input.start('part.gcode', {})
          return { ok: true, source: 'local', name: 'part.gcode' }
        },
      },
      driver: {
        controls: () => ['start_print'],
        prepare,
        async execute(_action, _args, { beforeSend }) {
          if (!beforeSend()) return { acknowledged: false }
          send()
          return { acknowledged: true }
        },
      },
    })
    const common = {
      v: 1 as const,
      purpose: 'api-envelope' as const,
      issuer: API_ENVELOPE_ISSUER,
      kid: 'test',
      app_id: appId,
      grant_id: grantId,
      farm_id: farmId,
      agent_id: agentId,
      assignment_id: assignmentId,
      resource_id: randomUUID(),
      cmd_id: randomUUID(),
      nonce: newApiEnvelopeNonce(),
      issued_at: wall,
      expires_at: wall + 30_000,
    }
    const sha256 = 'a'.repeat(64)
    const envelope =
      kind === 'library'
        ? {
            ...common,
            kind: 'action' as const,
            action: {
              action: 'start_library_print' as const,
              args: { sha256 },
            },
          }
        : {
            ...common,
            kind: 'job' as const,
            scope: 'jobs:start' as const,
            grant_epoch: wall,
            job: {
              file_url: 'https://localhost/part.gcode',
              sha256,
              size_bytes: 1,
              display_name: 'part.gcode',
            },
          }
    const wire = encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(envelope, pair.privateKey),
    })
    expect(observed).toBeNull()
    const result = await runner.run(wire)
    expect(prepare).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(ready ? 1 : 0)
    return result
  } finally {
    closeCommandJournal(journal)
    await rm(directory, { recursive: true, force: true })
  }
}

test.each([true, false])(
  'library and file starts agree when readiness is %s',
  async (ready) => {
    const expected = ready
      ? { kind: 'completed' }
      : { kind: 'refused', code: 'not-ready', detail: 'printer not ready' }
    expect(await runStart('library', ready)).toEqual(expected)
    expect(await runStart('file', ready)).toEqual(expected)
  },
)
