// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connect as netConnect,
  createServer as createNetServer,
} from 'node:net'
import { createServer } from 'node:tls'
import test from 'node:test'
import {
  importKobraClientCertFromInput,
  writeKobraClientCertFile,
} from '../../packages/connector/src/config/kobra-x-cert.ts'
import {
  connectAnycubicTls,
  PinMismatch,
} from '../../packages/connector/src/anycubic/tls-trust.ts'
import { provisionKobraXPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import {
  KOBRA_X_SIGNED_ACTIONS,
  kobraXControls,
  kobraXResultWindowMs,
  type KobraXControlEvidence,
} from '../../packages/connector/src/kobra-x/control-support.ts'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { createKobraXCollection } from '../../packages/connector/src/runtime/kobra-x-collection.ts'
import { startKobraXMock } from '../../packages/sim-tools/src/mocks/kobra-x-mock.ts'
import { generateKobraXThrowawayTls } from '../../packages/sim-tools/src/mocks/kobra-x-tls.ts'
import {
  installNetworkGuard,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/network-guard.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean, what: string) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return
    await sleep(20)
  }
  assert.fail(`${what} did not happen`)
}

// ---------------------------------------------------------------- #843

test('Kobra X controls follow the accessories the printer reported', () => {
  const none = { ace: false, light: false, fan: false }
  assert.deepEqual(kobraXControls(undefined), [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'start_print',
  ])
  assert.deepEqual(kobraXControls(none), kobraXControls(undefined))
  assert.deepEqual(kobraXControls({ ...none, light: true }), [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_light',
    'start_print',
  ])
  assert.deepEqual(kobraXControls({ ...none, fan: true }), [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    'start_print',
  ])
  assert.deepEqual(kobraXControls({ ...none, ace: true }), [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'start_print',
    'load_filament',
    'unload_filament',
  ])
  assert.deepEqual(
    kobraXControls({ ace: true, light: true, fan: true }),
    KOBRA_X_SIGNED_ACTIONS,
  )
})

async function collectionFixture(
  t: test.TestContext,
  accessories: { ace: boolean; light: boolean; fan: boolean },
) {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const printer = await startKobraXMock({
    ssdp: false,
    camera: false,
    reportIntervalMs: 0,
    accessories,
  })
  t.after(() => printer.close())
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kx-contract-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const clientCertFile = join(dir, 'client-cert.json')
  const imported = await importKobraClientCertFromInput({
    kind: 'inline',
    format: 'pem',
    certificate_pem: printer.tls.clientCert.toString(),
    key_pem: printer.tls.clientKey.toString(),
  })
  assert.ok(imported.ok)
  writeKobraClientCertFile(clientCertFile, imported.cert)
  const pinSha256 = printer.tls.serverFingerprintSha256
  assert.ok(pinSha256)
  const printerKey = 'kx-contract'
  const binding = {
    printerKey,
    host: '127.0.0.1',
    modelId: printer.credentials.modeId,
    deviceId: printer.credentials.deviceId,
    clientCertFile,
    pinSha256,
  }
  const assignment = {
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: printerKey,
  }
  const printerBinding = provisionKobraXPrinter(assignment, binding)
  const seen: (KobraXControlEvidence | undefined)[] = []
  let current: KobraXControlEvidence | undefined
  const controller = new AbortController()
  const collection = createKobraXCollection({
    binding,
    signal: controller.signal,
    endpoints: {
      address: '127.0.0.1',
      httpPort: printer.httpPort,
      mqttPort: printer.mqttPort,
    },
    pollMs: 20,
    onObservation() {},
    onUnavailable() {},
    onControlEvidence(evidence) {
      current = evidence
      seen.push(evidence)
    },
  })
  t.after(async () => {
    controller.abort()
    await collection.done
  })
  const router = createPauseDriverRouter({
    allowedOrigins: [],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 2000,
      requestTimeoutMs: 2000,
      staleAfterMs: 2000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    clock: { monotonicNow: () => performance.now() },
    kobraXControlEvidence: () => current,
    observe: () => false,
  })
  return { printer, printerBinding, router, seen, evidence: () => current }
}

test('a Kobra X without ACE, light or fan offers none of their controls and follows changes', async (t) => {
  const f = await collectionFixture(t, {
    ace: false,
    light: false,
    fan: false,
  })
  // Nothing has been reported yet: only accessory-free controls.
  assert.deepEqual(
    f.router.controls(f.printerBinding),
    kobraXControls(undefined),
  )
  await until(() => f.evidence() !== undefined, 'first evidence')
  assert.deepEqual(f.evidence(), { ace: false, light: false, fan: false })
  const bare = f.router.controls(f.printerBinding)
  for (const action of [
    'set_light',
    'set_fan',
    'load_filament',
    'unload_filament',
  ])
    assert.ok(!bare.includes(action as never), `${action} must not be offered`)
  assert.deepEqual(await f.router.detect(f.printerBinding), bare)

  // An ACE is attached: its controls appear, the others stay hidden.
  f.printer.control.setAccessories({ ace: true })
  await until(() => f.evidence()?.ace === true, 'ACE evidence')
  assert.deepEqual(f.router.controls(f.printerBinding), [
    ...bare,
    'load_filament',
    'unload_filament',
  ])

  f.printer.control.setAccessories({ light: true, fan: true })
  await until(
    () => f.evidence()?.light === true && f.evidence()?.fan === true,
    'light and fan evidence',
  )
  assert.deepEqual(f.router.controls(f.printerBinding), KOBRA_X_SIGNED_ACTIONS)

  // The ACE is detached again.
  f.printer.control.setAccessories({ ace: false })
  await until(() => f.evidence()?.ace === false, 'ACE removal')
  assert.ok(!f.router.controls(f.printerBinding).includes('load_filament'))
  assert.ok(f.router.controls(f.printerBinding).includes('set_light'))
})

test('Kobra X evidence is withdrawn when the printer goes away', async (t) => {
  const f = await collectionFixture(t, { ace: true, light: true, fan: true })
  await until(() => f.evidence()?.ace === true, 'full evidence')
  assert.deepEqual(f.router.controls(f.printerBinding), KOBRA_X_SIGNED_ACTIONS)
  await f.printer.close()
  await until(() => f.evidence() === undefined, 'withdrawn evidence')
  assert.deepEqual(
    f.router.controls(f.printerBinding),
    kobraXControls(undefined),
  )
  assert.deepEqual(f.seen.at(-1), undefined)
})

// ---------------------------------------------------------------- #844

test('a failing report observer cannot keep a command result from settling', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const printer = await startKobraXMock({
    ssdp: false,
    camera: false,
    reportIntervalMs: 0,
  })
  t.after(() => printer.close())
  const errors: Error[] = []
  const adapter = await connectKobraX({
    address: '127.0.0.1',
    printerKey: 'observer-throws',
    clientIdentity: {
      cert: printer.tls.clientCert,
      key: printer.tls.clientKey,
    },
    pinSha256: printer.tls.serverFingerprintSha256!,
    httpPort: printer.httpPort,
    mqttPort: printer.mqttPort,
    resultTimeoutMs: 1500,
    onError: (error) => errors.push(error),
    onReport() {
      throw new Error('observer failed')
    },
  })
  t.after(() => adapter.close())
  await until(() => adapter.snapshot().state === 'idle', 'idle state')
  const outcome = await adapter.control.execute(
    'set_light',
    { on: true },
    { beforeSend: () => true },
  )
  assert.equal(outcome.kind, 'confirmed')
  assert.equal(printer.control.getState().state, 'idle')
  assert.ok(errors.some((error) => error.message === 'observer failed'))
  assert.equal(
    printer.calls.all.filter(({ topic }) => /\/light$/.test(topic)).length,
    1,
    'the command was written once',
  )
})

test('the Kobra X result window covers the sequence after the write', () => {
  // request result 5 s + current-state wait 3 s; start_print adds its 1.5 s watch.
  for (const action of KOBRA_X_SIGNED_ACTIONS) {
    const window = kobraXResultWindowMs(action)
    assert.ok(window !== undefined && window > 8000 && window <= 24_000, action)
  }
  assert.ok(
    kobraXResultWindowMs('start_print')! > kobraXResultWindowMs('pause')!,
  )
  assert.equal(kobraXResultWindowMs('home'), undefined)
})

// ---------------------------------------------------------------- #848

function tlsFixture(
  t: test.TestContext,
  version: 'TLSv1.2' | 'TLSv1.3' = 'TLSv1.3',
) {
  const material = generateKobraXThrowawayTls({ dirPrefix: 'kx-contract-tls-' })
  t.after(material.cleanup)
  const server = createServer({
    key: material.server.key,
    cert: material.server.cert,
    ca: material.ca.cert,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: version,
    maxVersion: version,
  })
  // Whether each accepted connection presented a client certificate.
  const peers: boolean[] = []
  const received: Buffer[] = []
  // Every byte the client put on the wire, below TLS.
  const wire: Buffer[] = []
  server.on('secureConnection', (socket) => {
    peers.push(!!socket.getPeerCertificate()?.raw)
    socket.on('data', (chunk) => received.push(chunk))
    socket.on('error', () => {})
  })
  server.on('tlsClientError', () => {})
  // A transparent relay in front of the server counts what the client sends.
  const relay = createNetServer((client) => {
    const upstream = netConnect({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
    })
    client.on('data', (chunk) => {
      wire.push(chunk)
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => client.write(chunk))
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
    client.on('error', () => {})
    upstream.on('error', () => {})
  })
  const ready = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      relay.listen(0, '127.0.0.1', () =>
        resolve((relay.address() as { port: number }).port),
      ),
    ),
  )
  t.after(
    () =>
      new Promise<void>((resolve) =>
        relay.close(() => server.close(() => resolve())),
      ),
  )
  const spki = createHash('sha256')
    .update(
      new X509Certificate(material.server.cert).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('hex')
  const wrong = createHash('sha256')
    .update(
      new X509Certificate(material.client.cert).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('hex')
  async function attempt(
    pin: string | undefined,
    extra: {
      ca?: Buffer
      hold?: boolean
      minVersion?: 'TLSv1.2' | 'TLSv1.3'
    } = {},
  ) {
    const port = await ready
    const socket = connectAnycubicTls(
      {
        host: '127.0.0.1',
        port,
        cert: material.client.cert,
        key: material.client.key,
        minVersion: extra.minVersion ?? 'TLSv1.3',
        ...(extra.ca ? { ca: extra.ca } : {}),
      },
      pin,
      { holdClientIdentity: extra.hold ?? true },
    )
    let error: Error | undefined
    socket.on('error', (failure) => (error ??= failure))
    await new Promise<void>((resolve) => {
      socket.once('error', () => resolve())
      socket.once('secureConnect', () => {
        // Refused peers are destroyed in this same tick, before the write.
        if (!socket.destroyed) socket.write('application-data')
        resolve()
      })
    })
    await sleep(150)
    socket.destroy()
    const clientCertificateReached = peers.some(Boolean)
    return {
      error,
      clientCertificateReached,
      applicationData: Buffer.concat(received).toString(),
      /** Bytes sent after the first TLS record, the ClientHello. */
      bytesAfterClientHello: (() => {
        const all = Buffer.concat(wire)
        return all.length < 5 ? 0 : all.length - (5 + all.readUInt16BE(3))
      })(),
    }
  }
  function reset() {
    peers.length = 0
    received.length = 0
    wire.length = 0
  }
  return { material, spki, wrong, attempt, reset }
}

test('a pin mismatch stops the Kobra X client identity and all data before they are sent', async (t) => {
  const f = tlsFixture(t)
  const mismatch = await f.attempt(f.wrong)
  assert.ok(mismatch.error instanceof PinMismatch)
  assert.equal(mismatch.clientCertificateReached, false)
  assert.equal(mismatch.applicationData, '')
  assert.equal(
    mismatch.bytesAfterClientHello,
    0,
    'nothing but the ClientHello left the client',
  )
  f.reset()
  const match = await f.attempt(f.spki)
  assert.equal(match.error, undefined)
  assert.equal(match.clientCertificateReached, true)
  assert.equal(match.applicationData, 'application-data')
  assert.ok(match.bytesAfterClientHello > 0)
})

test('a CA together with a pin means both must hold', async (t) => {
  const f = tlsFixture(t)
  // Matching CA and matching pin: accepted.
  const both = await f.attempt(f.spki, { ca: f.material.server.cert })
  assert.equal(both.error, undefined)
  assert.equal(both.clientCertificateReached, true)
  f.reset()
  // The right CA does not excuse a wrong pin.
  const wrongPin = await f.attempt(f.wrong, { ca: f.material.server.cert })
  assert.ok(wrongPin.error instanceof PinMismatch)
  assert.equal(wrongPin.clientCertificateReached, false)
  assert.equal(wrongPin.bytesAfterClientHello, 0)
  f.reset()
  // The right pin does not excuse a CA that cannot verify the printer.
  const wrongCa = await f.attempt(f.spki, { ca: f.material.ca.cert })
  assert.ok(wrongCa.error)
  assert.ok(!(wrongCa.error instanceof PinMismatch))
  assert.equal(wrongCa.clientCertificateReached, false)
  assert.equal(wrongCa.bytesAfterClientHello, 0)
  assert.equal(wrongCa.applicationData, '')
})

test('a CA that cannot verify the peer gets no client identity without a pin either', async (t) => {
  const f = tlsFixture(t)
  const result = await f.attempt(undefined, { ca: f.material.ca.cert })
  assert.ok(result.error)
  assert.equal(result.clientCertificateReached, false)
  assert.equal(result.bytesAfterClientHello, 0)
})

test('a peer that forces TLS 1.2 never receives the Kobra X client certificate', async (t) => {
  // TLS 1.2 sends the client certificate before JavaScript sees the server's.
  // The Kobra X client accepts only TLS 1.3, where the flight can be held.
  const f = tlsFixture(t, 'TLSv1.2')
  const result = await f.attempt(f.spki)
  assert.ok(result.error)
  assert.equal(result.clientCertificateReached, false)
  assert.equal(result.bytesAfterClientHello, 0)
})

test('Node itself sends the client certificate to a TLS 1.2 peer it then refuses', async (t) => {
  // Characterization of why the hold exists: without it, a pin mismatch is
  // found only after the certificate has left.
  const f = tlsFixture(t, 'TLSv1.2')
  const result = await f.attempt(f.wrong, {
    hold: false,
    minVersion: 'TLSv1.2',
  })
  assert.ok(result.error instanceof PinMismatch)
  assert.equal(result.clientCertificateReached, true)
})
