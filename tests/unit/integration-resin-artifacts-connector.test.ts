import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createLibraryCache } from '../../packages/connector/src/runtime/library-cache.ts'
import { createLibraryPrintStarter } from '../../packages/connector/src/runtime/library-print-start.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  acceptedArtifact,
  evidence,
} from '../fixtures/resin-artifacts/contracts.ts'

it.each([
  'unsupported',
  'mismatch',
  'invalid-payload',
  'corrupt-download',
  'qualified',
] as const)(
  'checks resin dispatch over the signed Connector path (%s)',
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'openfarm-resin-command-'))
    const ledger = process.env.OPENFARM_RESIN_ARTIFACT_TEST_LEDGER
    if (ledger)
      appendFileSync(ledger, `Created and owns test journal ${directory}\n`)
    const wall = Date.now()
    const journal = openCommandJournal({ directory, clock: () => wall })
    try {
      const keys = await crypto.subtle.generateKey('Ed25519', false, [
        'sign',
        'verify',
      ])
      const [farmId, agentId, appId, grantId, assignmentId, versionId, jobId] =
        Array.from({ length: 7 }, () => randomUUID()) as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      const origin = 'http://127.0.0.1:7125'
      const binding = createPrinterBindingRegistry({
        allowedOrigins: [origin],
      }).provision({
        assignment_id: assignmentId,
        farm_id: farmId,
        agent_id: agentId,
        printer_key: 'resin-fixture',
        moonraker_origin: origin,
      })
      const report = vi.fn<(wire: string) => void>()
      const genericExecute = vi.fn()
      const bytes = Buffer.from(evidence)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const download = vi.fn(async () => ({
        stream: Readable.from([
          scenario === 'corrupt-download' ? Buffer.from('corrupt') : bytes,
        ]),
      }))
      const libraryPrint = createLibraryPrintStarter({
        cache: await createLibraryCache({
          directory: join(directory, 'cache'),
          maxBytes: 1024,
        }),
        download,
        profile: async () => undefined,
      })
      const physicalStart = vi.fn()
      const capability = {
        assignmentId,
        profile:
          scenario === 'mismatch'
            ? 'anycubic:photon-mono-m7-pro'
            : acceptedArtifact.profile,
        extensions: ['.pm7m'],
        validate: vi.fn(async ({ path }: { path: string }) => {
          expect(await readFile(path)).toEqual(bytes)
          return scenario === 'invalid-payload'
            ? ({ ok: false, reason: 'artifact-profile-mismatch' } as const)
            : ({ ok: true } as const)
        }),
        async dispatch({ beforeSend }: { beforeSend(): boolean }) {
          if (!beforeSend()) return false
          physicalStart()
          return true
        },
      } as const
      const runner = createApiCommandRunner({
        farmId,
        agentId,
        journal,
        report,
        keys: { issuer: () => keys.publicKey },
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
        observe: () => ({ ready: true, printState: 'idle' }),
        clock: { wallNow: () => wall, monotonicNow: () => 1000 },
        libraryPrint,
        resinCapabilities: () =>
          scenario === 'unsupported' ? [] : [capability],
        driver: { execute: genericExecute },
      })
      const wire = encodeApiEnvelopeFrame({
        v: 1,
        t: 'api-envelope.command',
        envelope: await signApiEnvelope(
          {
            v: 1,
            purpose: 'api-envelope',
            issuer: API_ENVELOPE_ISSUER,
            kid: 'fixture',
            app_id: appId,
            grant_id: grantId,
            farm_id: farmId,
            agent_id: agentId,
            assignment_id: assignmentId,
            resource_id: jobId,
            cmd_id: randomUUID(),
            nonce: newApiEnvelopeNonce(),
            issued_at: wall,
            expires_at: wall + 30_000,
            kind: 'action',
            action: {
              action: 'start_library_print',
              args: {
                ...acceptedArtifact,
                versionId,
                sha256,
              },
            },
          },
          keys.privateKey,
        ),
      })
      const result = await runner.run(wire)
      if (scenario === 'qualified') {
        expect(result.kind).toBe('completed')
        expect(physicalStart).toHaveBeenCalledTimes(1)
      } else {
        const detail = {
          unsupported: 'resin-artifact-dispatch-unavailable',
          mismatch: 'profile-mismatch',
          'invalid-payload': 'artifact-profile-mismatch',
          'corrupt-download': 'checksum-mismatch',
        }[scenario]
        const code =
          scenario === 'corrupt-download' ? 'checksum-mismatch' : 'unsupported'
        expect(result).toMatchObject({
          kind: 'refused',
          code,
          detail,
        })
        expect(physicalStart).not.toHaveBeenCalled()
        expect(
          decodeApiEnvelopeResultFrame(report.mock.calls[0]![0]),
        ).toMatchObject({
          outcome: 'refused',
          refusal_code: code,
          detail,
        })
      }
      expect(genericExecute).not.toHaveBeenCalled()
      expect(download).toHaveBeenCalledTimes(
        scenario === 'unsupported' || scenario === 'mismatch' ? 0 : 1,
      )
      expect((await runner.run(wire)).kind).toBe('dropped')
    } finally {
      closeCommandJournal(journal)
      await rm(directory, { recursive: true, force: true })
      if (ledger) appendFileSync(ledger, `Removed test journal ${directory}\n`)
    }
  },
)
