import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'

test(
  'agent publishes discovered Moonraker macros in its snapshot',
  { timeout: 60_000 },
  async () => {
    const remote = await pauseFixture({
      objects: [
        'gcode_macro CLEAN',
        'gcode_macro _PRIVATE',
        'gcode_macro LOAD_FILAMENT',
      ],
    })
    const directory = mkdtempSync(join(tmpdir(), 'agent-macros-'))
    const controller = new AbortController()
    // Keep the real agent, pause runtime, discovery and snapshot composition.
    // Replace only cloud lifecycle transport; expose the snapshot for inspection.
    const probe = { read: () => undefined as unknown }
    Object.assign(globalThis, { agentMacrosProbe: probe })
    const hooks = registerHooks({
      load(url, context, next) {
        if (url.endsWith('/runtime/signalling.ts'))
          return {
            format: 'module',
            shortCircuit: true,
            source: `export async function runSignallingLifecycle({signal}) { if (!signal.aborted) await new Promise(r => signal.addEventListener('abort', r, {once:true})); }`,
          }
        if (url.endsWith('/runtime/farm-snapshot-provider.ts')) {
          const source = readFileSync(new URL(url), 'utf8').replace(
            'return { observe, invalidate, setInventory, open, close }',
            `globalThis.agentMacrosProbe.read = () => { const now = performance.now(); observe({ printerKey: refs[0].printerKey, epoch: 100, printer: { printerKey: refs[0].printerKey, state: 'idle', progress: 0, observedAt: Date.now() }, receivedAtMonoMs: now, fieldObservedAtMonoMs: { webhooks: now, printState: now, progress: now } }); return snapshot(now, now + 5000); }; return { observe, invalidate, setInventory, open, close }`,
          )
          return { format: 'module-typescript', shortCircuit: true, source }
        }
        return next(url, context)
      },
    })
    let running: Promise<void> | undefined
    try {
      const identity = loadOrCreateIdentity(directory)
      const agent = randomUUID(),
        farm = randomUUID(),
        assignment = randomUUID()
      const origin = 'https://127.0.0.1:1'
      const signalling = {
        origin,
        audience: 'fixture',
        endpoint:
          origin.replace('https:', 'wss:') + '/api/signalling/connector',
      }
      const config = {
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [remote.origin],
          printers: [{ printerKey: 'printer', origin: remote.origin }],
        },
        assignments: [
          {
            assignment_id: assignment,
            agent_id: agent,
            farm_id: farm,
            printer_key: 'printer',
            moonraker_origin: remote.origin,
          },
        ],
        telemetry: {
          endpoint: origin + '/api/connector/telemetry',
          audience: 'fixture',
        },
        signalling,
        pause: {
          version: 1,
          control: { assignmentId: assignment },
          issuers: [
            {
              issuer: 'fixture',
              kid: 'fixture',
              publicKeySpki: generateKeyPairSync('ed25519')
                .publicKey.export({ format: 'der', type: 'spki' })
                .toString('base64url'),
            },
          ],
          signalling: {
            ...signalling,
            endpoint:
              origin.replace('https:', 'wss:') +
              '/api/signalling/pause-connector',
            credentialAudience: 'fixture',
          },
        },
      }
      const configPath = join(directory, 'config.json'),
        credentialPath = join(directory, 'credential.json')
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
      writeFileSync(
        credentialPath,
        JSON.stringify({
          version: 1,
          expected_fingerprint: identity.fingerprint,
          approval: {
            status: 'approved',
            agent_id: agent,
            farm_id: farm,
            device_token:
              'e30.' +
              Buffer.from(JSON.stringify({ jti: randomUUID() })).toString(
                'base64url',
              ) +
              '.AA',
            expires_at: Date.now() + 60000,
          },
        }),
        { mode: 0o600 },
      )
      const { runConnectorAgent } =
        await import('../../packages/connector/src/runtime/agent.ts')
      let failure: unknown
      let settled = false
      running = runConnectorAgent({
        configPath,
        credentialPath,
        dataDirectory: directory,
        signal: controller.signal,
        onDiagnostic(value) {
          assert.notEqual(value.kind, 'pause-failed')
        },
      })
        .catch((error) => {
          failure = error
        })
        .finally(() => {
          settled = true
        })
      // Wait on the agent, not on a wall-clock budget: agent startup (dynamic
      // imports, TS stripping) runs on this thread and can block the loop for
      // seconds on a loaded host. A read always follows the last wait, so the
      // assertion never sees a value taken before discovery ran. The test-level
      // timeout bounds a genuine hang.
      let snapshot
      for (;;) {
        if (failure) throw failure
        snapshot = probe.read()
        if (settled || JSON.stringify(snapshot)?.includes('CLEAN')) break
        await delay(10)
      }
      assert.match(JSON.stringify(snapshot), /"macros":\["CLEAN"\]/)
      assert.deepEqual(remote.gcodeScripts, [])
    } finally {
      controller.abort()
      await running
      hooks.deregister()
      Reflect.deleteProperty(globalThis, 'agentMacrosProbe')
      await remote.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
