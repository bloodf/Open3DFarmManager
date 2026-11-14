import assert from 'node:assert/strict'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JSHandle } from '@playwright/test'
import { browserBundle } from '../browser-bundle.ts'
import type { createSignallingRtcBrowserActor } from '../signalling-rtc-browser.ts'
import type { SignallingFixtureExtension } from '../signalling-https-fixture-contract.ts'
import { loadOrCreateIdentity } from '../../../packages/connector/src/identity/store.ts'
import { runConfigurationConnector } from '../../../packages/connector/src/runtime/configuration-command.ts'
import { configurationConnectorSocket } from '../../../packages/connector/src/webrtc/configuration-signalling.ts'
import { driveFirstRegistration } from '../../e2e/kobralink-rtc.spec.ts'

type Actor = Awaited<ReturnType<typeof createSignallingRtcBrowserActor>>
export function createAuthenticatedRtcFixtureExtension(): SignallingFixtureExtension {
  let actor: JSHandle<Actor> | undefined
  const root = process.env.KOBRALINK_RTC_RUN_DIRECTORY
  if (!root) throw Error('Private owned run directory required')
  const dataDirectory = join(root, 'identity')
  const credentialPath = join(root, 'credential.json')
  const provisioningPath = join(root, 'provisioning.json')
  const controller = new AbortController()
  let done: Promise<void> | undefined
  return {
    async identityHandles(input) {
      await mkdir(dataDirectory, { mode: 0o700 })
      const identity = loadOrCreateIdentity(dataDirectory)
      const bundle = await browserBundle(
        new URL('../signalling-rtc-browser.ts', import.meta.url).pathname,
        input.signal,
      )
      const path = input.origin + '/__registration_fixture__.js'
      await input.ownerPage.route(path, (route) =>
        route.fulfill({ contentType: 'text/javascript', body: bundle }),
      )
      actor = await input.ownerPage.evaluateHandle(
        async ({ path, scope }) => {
          const module: typeof import('../signalling-rtc-browser.ts') =
            await import(path)
          return module.createSignallingRtcBrowserActor(scope)
        },
        {
          path,
          scope: {
            accountId: input.accountId,
            farmId: input.farmId,
            origin: input.origin,
            audience: input.audience,
            persistKey: true,
          },
        },
      )
      const owned = actor
      return {
        browser: {
          publicJwk: await owned.evaluate((a) => a.publicJwk),
          signEnrollment: (challenge) =>
            owned.evaluate((a, c) => a.signEnrollment(c), challenge),
        },
        connector: {
          publicKeySpki: identity.publicKeySpki,
          fingerprint: identity.fingerprint,
          async signPairing(challenge, origin, audience) {
            return identity.signPairingProof({
              challenge,
              expectedOrigin: origin,
              expectedAudience: audience,
              now: Date.now(),
            })
          },
        },
        async dispose() {
          controller.abort()
          await done
          await owned
            .evaluate((a) => a.close())
            .catch((error: unknown) => {
              if (!String(error).includes('Execution context was destroyed'))
                throw error
            })
          await owned.dispose()
          await input.ownerPage.unroute(path)
        },
      }
    },
    async afterProvisioned(input) {
      assert.equal(input.assignmentRefs.length, 0)
      await writeFile(
        credentialPath,
        JSON.stringify({
          version: 1,
          expected_fingerprint: input.identities.connector.fingerprint,
          approval: input.claim,
        }),
        { mode: 0o600, flag: 'wx' },
      )
      await writeFile(
        provisioningPath,
        JSON.stringify({
          version: 1,
          mode: 'configuration-provisioning',
          farm_id: input.farmId,
          agent_id: input.claim.agent_id,
          farmOrigin: input.origin,
          credentialAudience: input.audience,
          stateDirectory: join(root, 'state'),
          runtimeConfigPath: join(root, 'runtime.json'),
          printerNetworks: ['172.30.78.0/24'],
          managedBridge: {
            origin: `http://127.0.0.1:${process.env.KOBRALINK_RTC_KOBRA_PORT}`,
            ownership: 'connector-owned-fresh',
          },
          runtimeTemplate: {
            telemetry: {
              endpoint: input.origin + '/api/connector/telemetry',
              audience: input.audience,
            },
            signalling: {
              endpoint:
                input.origin.replace('https:', 'wss:') +
                '/api/signalling/connector',
              origin: input.origin,
              audience: input.audience,
            },
            rtc: { bindAddress: '127.0.0.1' },
          },
          rtc: { bindAddress: '127.0.0.1' },
        }),
        { mode: 0o600, flag: 'wx' },
      )
      const events: Readonly<Record<string, unknown>>[] = []
      const startedAt = performance.now()
      const ALLOWED_T = new Set([
        'config.connector-begin',
        'config.connector-challenge',
        'config.connector-proof',
        'config.connector-ready',
        'config.advertise',
        'config.retry',
        'config.context-request',
        'config.binding',
        'config.context-closed',
        'rtc.offer',
        'rtc.answer',
        'rtc.ice',
        'rtc.close',
      ])
      const frameKind = (raw: unknown): string => {
        try {
          if (typeof raw !== 'string') return 'non-string'
          const parsed: unknown = JSON.parse(raw)
          const t =
            parsed && typeof parsed === 'object' && 't' in parsed
              ? parsed.t
              : undefined
          return typeof t === 'string' && ALLOWED_T.has(t) ? t : 'other'
        } catch {
          return 'invalid'
        }
      }
      const boundary = (entry: Readonly<Record<string, unknown>>) =>
        appendFile(
          join(root, 'boundary.jsonl'),
          JSON.stringify({
            atMs: Math.round(performance.now() - startedAt),
            ...entry,
          }) + '\n',
          { mode: 0o600 },
        ).catch(() => {})
      const transport = globalThis.fetch
      globalThis.fetch = async (resource, init) => {
        const value =
          resource instanceof Request ? resource.url : String(resource)
        const url = new URL(value)
        const started = performance.now()
        try {
          const response = await transport(resource, init)
          await appendFile(
            join(root, 'transport.jsonl'),
            JSON.stringify({
              origin: url.origin,
              path: url.pathname,
              method: init?.method ?? 'GET',
              status: response.status,
              ms: Math.round(performance.now() - started),
            }) + '\n',
            { mode: 0o600 },
          )
          return response
        } catch (error) {
          await appendFile(
            join(root, 'transport.jsonl'),
            JSON.stringify({
              origin: url.origin,
              path: url.pathname,
              method: init?.method ?? 'GET',
              error: error instanceof Error ? error.name : 'unknown',
              ms: Math.round(performance.now() - started),
            }) + '\n',
            { mode: 0o600 },
          )
          throw error
        }
      }

      let failure: unknown
      done = runConfigurationConnector({
        provisioningPath,
        dataDirectory,
        credentialPath,
        signal: controller.signal,
        async socket() {
          const inner = await configurationConnectorSocket(input.origin)
          await boundary({ side: 'connector-ws', state: 'created' })
          return {
            send(wire) {
              void boundary({
                side: 'connector-ws-out',
                t: frameKind(wire),
                bytes: Buffer.byteLength(wire),
              })
              inner.send(wire)
            },
            close() {
              void boundary({ side: 'connector-ws', state: 'close-call' })
              inner.close()
            },
            bind(handlers) {
              inner.bind({
                message(raw) {
                  void boundary({
                    side: 'connector-ws-in',
                    t: frameKind(raw),
                    bytes: typeof raw === 'string' ? Buffer.byteLength(raw) : 0,
                  })
                  handlers.message(raw)
                },
                close() {
                  void boundary({ side: 'connector-ws', state: 'closed' })
                  handlers.close()
                },
              })
            },
          }
        },
        onDiagnostic(event) {
          events.push(event)
          void appendFile(
            join(root, 'connector.jsonl'),
            JSON.stringify(event) + '\n',
            { mode: 0o600 },
          )
        },
      }).catch((error) => {
        failure = error
      })
      try {
        await driveFirstRegistration({
          page: input.ownerPage,
          origin: input.origin,
          farmId: input.farmId,
          agentId: input.claim.agent_id,
          browserKeyId: input.browserKeyId,
          evidence: root,
          events,
        })
      } catch (error) {
        await input.ownerPage
          .screenshot({
            path: join(root, 'failure-desktop1280.png'),
            fullPage: true,
          })
          .catch(() => {})
        console.error(error)
        throw error
      }
      globalThis.fetch = transport
      if (failure) throw failure
    },
  }
}
