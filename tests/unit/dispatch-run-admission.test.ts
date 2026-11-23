// spec-derived, not captured — https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import { createLibraryJobLinks } from '../../packages/connector/src/runtime/library-job-links.ts'

const sha256 = 'a'.repeat(64)
const filename = 'part.gcode'

async function fixture(options: {
  wrongSignature?: boolean
  missingScope?: boolean
  goesBusy?: boolean
  scopeRevokedAtSend?: boolean
  loseAck?: boolean
}) {
  const directory = await mkdtemp(join(tmpdir(), 'openfarm-dispatch-journal-'))
  const wall = Date.now()
  const journal = openCommandJournal({ directory, clock: () => wall })
  try {
    const pair = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const other = options.wrongSignature
      ? await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
      : pair
    const farmId = randomUUID()
    const agentId = randomUUID()
    const appId = randomUUID()
    const grantId = randomUUID()
    const assignmentId = randomUUID()
    const cmdId = randomUUID()
    const origin = 'http://127.0.0.1:7125'
    const registry = createPrinterBindingRegistry({ allowedOrigins: [origin] })
    const binding = registry.provision({
      assignment_id: assignmentId,
      farm_id: farmId,
      agent_id: agentId,
      printer_key: 'mock',
      moonraker_origin: origin,
    })
    let printState = 'idle'
    let hasScope = !options.missingScope
    const requests = vi.fn()
    const report = vi.fn()
    const links = createLibraryJobLinks()
    const run = createApiCommandRunner({
      farmId,
      agentId,
      journal,
      report,
      keys: { issuer: () => pair.publicKey },
      grants: {
        lookup: () => ({
          grant_id: grantId,
          app_id: appId,
          farm_id: farmId,
          scopes: hasScope ? ['jobs:write'] : ['jobs:start'],
          revoked: false,
        }),
        freshness: { freshAt: () => true },
      },
      printer: () => binding,
      observe: () => ({ ready: true, printState }),
      clock: { wallNow: () => wall, monotonicNow: () => 1000 },
      libraryLinks: links,
      jobFiles: {
        directory,
        targetFor: () => ({ backend: 'moonraker', origin }),
      },
      libraryPrint: {
        async start(input) {
          if (!input.authorize()) throw new Error('refused')
          await input.start(filename, {})
          return { ok: true, source: 'local', name: filename }
        },
      },
      driver: {
        controls: () => ['start_print'],
        async execute(action, args, { beforeSend }) {
          if (options.scopeRevokedAtSend) hasScope = false
          if (options.goesBusy) printState = 'printing'
          if (!beforeSend()) return { acknowledged: false }
          requests(action, args)
          links.attach({
            printerKey: 'mock',
            observedAt: wall + 1,
            state: 'printing',
            filename,
          })
          if (options.loseAck) throw new Error('acknowledgement lost')
          return { acknowledged: true }
        },
      },
    }).run
    const wire = encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'test-key',
          app_id: appId,
          grant_id: grantId,
          farm_id: farmId,
          agent_id: agentId,
          assignment_id: assignmentId,
          resource_id: randomUUID(),
          cmd_id: cmdId,
          nonce: newApiEnvelopeNonce(),
          issued_at: wall,
          expires_at: wall + 30_000,
          kind: 'action',
          action: { action: 'start_library_print', args: { sha256 } },
        },
        other.privateKey,
      ),
    })
    return {
      wire,
      run,
      requests,
      report,
      journal,
      cmdId,
      links,
      wall,
      async close() {
        closeCommandJournal(journal)
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    closeCommandJournal(journal)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

describe('Connector library dispatch admission', () => {
  test.each([
    [{ wrongSignature: true }, { kind: 'dropped', reason: 'invalid' }],
    [
      { missingScope: true },
      {
        kind: 'refused',
        code: 'grant-revoked',
        detail: 'action outside the granted scope',
      },
    ],
    [
      { scopeRevokedAtSend: true },
      {
        kind: 'refused',
        code: 'grant-revoked',
        detail: 'action outside the granted scope',
      },
    ],
    [
      { goesBusy: true },
      { kind: 'refused', code: 'printer-busy', detail: 'printer is printing' },
    ],
  ] as const)(
    'refuses %j before issuing a printer request',
    async (options, result) => {
      const f = await fixture(options)
      try {
        expect(await f.run(f.wire)).toEqual(result)
        expect(f.requests).not.toHaveBeenCalled()
        if (result.kind === 'dropped') expect(f.report).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    },
  )

  test('losing an acknowledgement records uncertainty, and observed completion can still link', async () => {
    const f = await fixture({ loseAck: true })
    try {
      expect(await f.run(f.wire)).toEqual({ kind: 'outcome-unknown' })
      expect(readCommandOutcome(f.journal, f.cmdId)?.status).toBe(
        'outcome-unknown',
      )
      expect(await f.run(f.wire)).toEqual({ kind: 'dropped', reason: 'replay' })
      expect(f.requests).toHaveBeenCalledExactlyOnceWith('start_print', {
        file: filename,
      })
      expect(f.report).not.toHaveBeenCalled()
      expect(
        f.links.attach({
          printerKey: 'mock',
          observedAt: f.wall + 3,
          state: 'idle',
          lastJob: { filename, outcome: 'completed', endedAt: f.wall + 2 },
        }).lastJob?.sha256,
      ).toBe(sha256)
    } finally {
      await f.close()
    }
  })
})
