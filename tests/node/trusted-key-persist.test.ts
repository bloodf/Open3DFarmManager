import test from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTrustedKeyStore } from '../../packages/connector/src/auth/trusted-key-store.ts'
import { createPauseCapabilityVerifier } from '../../packages/connector/src/auth/pause-capability.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  signTrustedKeySet,
  encodeTrustedKeySetFrame,
} from '../../packages/farm-protocol/src/trusted-keys.ts'
import * as caps from '../../packages/farm-protocol/src/pause-capability.ts'
import * as controls from '../../packages/farm-protocol/src/control-session-binding.ts'
async function commandFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { publicKey } = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const command = {
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture() {
  const { pair, publicKey, command } = await commandFixture()
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const { createHash } = await import('node:crypto')
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: command.transport_id,
    farm_id: command.farm_id,
    agent_id: command.agent_id,
    account_id: command.account_id,
    key_id: command.key_id,
    assignment_id: command.assignment_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: 1000,
    expires_at: 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const { controlBindingHash } =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const bindingHash = await controlBindingHash(binding),
    admissionNonce = digest()
  const capability = {
    v: 1 as const,
    purpose: 'pause-authority' as const,
    capability_id: command.capability_id,
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: binding.audience,
    origin: binding.origin,
    issued_at: 1000,
    expires_at: 30000,
    account_id: command.account_id,
    role: 'operator' as const,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_fingerprint: binding.connector_fingerprint,
    credential_jti: binding.credential_jti,
    printer_key: 'é"\\'.repeat(32),
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    actions: ['pause'] as ['pause'],
  }
  const challenge = {
    v: 1 as const,
    purpose: 'pause-admission' as const,
    challenge_id: randomUUID(),
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    account_id: binding.account_id,
    browser_thumbprint: thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    issued_at: 1000,
    expires_at: 9000,
  }
  return {
    pair,
    publicKey,
    command,
    issuer,
    connector,
    binding,
    capability,
    challenge,
  }
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'trusted-key-persist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const f = await authorityFixture()
  const path = join(dir, 'keys.json')
  const diagnostics: string[] = []
  const anchors = [
    {
      issuer: f.capability.issuer,
      kid: 'issuer-1',
      publicKey: f.issuer.publicKey,
    },
  ]
  const options = {
    path,
    farmId: f.binding.farm_id,
    issuers: anchors,
    onDiagnostic: (code: string) => {
      diagnostics.push(code)
    },
  }
  const store = await openTrustedKeyStore(options)
  const rotated = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  async function wire(
    version: number,
    revoked = false,
    signer = f.issuer,
    kid = 'issuer-1',
  ) {
    const entry = async (pair: CryptoKeyPair, kid: string) => ({
      issuer: f.capability.issuer,
      kid,
      public_key_spki: Buffer.from(
        await crypto.subtle.exportKey('spki', pair.publicKey),
      ).toString('base64url'),
    })
    return encodeTrustedKeySetFrame({
      v: 1,
      t: 'trusted-keys.set',
      key_set: await signTrustedKeySet(
        {
          v: 1,
          purpose: 'trusted-key-set',
          farm_id: f.binding.farm_id,
          version,
          issued_at: 1000,
          issuer: f.capability.issuer,
          kid,
          issuer_keys: [
            await entry(f.issuer, 'issuer-1'),
            await entry(rotated, 'issuer-2'),
          ],
          browser_keys: revoked
            ? []
            : [
                {
                  key_id: f.binding.key_id,
                  account_id: f.binding.account_id,
                  thumbprint: f.binding.browser_thumbprint,
                  public_key: f.publicKey,
                },
              ],
        },
        signer.privateKey,
      ),
    })
  }
  return { f, dir, path, diagnostics, options, store, rotated, wire }
}

test('private atomic checkpoint survives restart, rejects rollback and conflicting versions', async (t) => {
  const f = await setup(t)
  const first = await f.wire(1)
  assert.equal(await f.store.confirm(first), true)
  assert.equal((await stat(f.path)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(f.dir), ['keys.json'])
  assert.equal(await f.store.confirm(first), true)
  const second = await f.wire(2, false, f.rotated, 'issuer-2')
  assert.equal(await f.store.confirm(second), true)
  const restarted = await openTrustedKeyStore(f.options)
  assert.equal(restarted.version, 2)
  assert.equal(await restarted.confirm(first), false)
  assert.equal(await restarted.confirm(await f.wire(2, true)), false)
  assert.equal(await readFile(f.path, 'utf8'), second)
  assert.equal(restarted.authority.allowsBrowser(f.f.capability), true)
  assert.equal(
    await restarted.confirm(await f.wire(3, true, f.rotated, 'issuer-2')),
    true,
  )
  assert.equal(restarted.authority.allowsBrowser(f.f.capability), false)
})

test('corrupt checkpoint fails closed and reports only a fixed diagnostic', async (t) => {
  const f = await setup(t)
  await writeFile(f.path, 'SECRET-credential-invalid-json', { mode: 0o600 })
  await assert.rejects(openTrustedKeyStore(f.options), {
    message: 'Trusted key storage unavailable',
  })
  assert.deepEqual(f.diagnostics, ['trusted-keys-storage-invalid'])
})

test('untrusted signer, wrong farm and invalid signature cannot replace the checkpoint', async (t) => {
  const f = await setup(t)
  assert.equal(
    await f.store.confirm(await f.wire(1, false, f.rotated, 'issuer-2')),
    false,
  )
  const first = await f.wire(1)
  assert.equal(await f.store.confirm(first), true)
  const altered = JSON.parse(await f.wire(2))
  altered.key_set.browser_keys = []
  assert.equal(await f.store.confirm(encodeTrustedKeySetFrame(altered)), false)
  altered.key_set.farm_id = randomUUID()
  await assert.rejects(f.store.confirm(encodeTrustedKeySetFrame(altered)))
  assert.equal(await readFile(f.path, 'utf8'), first)
})

test('rotated issuer admits without restart; one revocation invalidates existing and new capabilities', async (t) => {
  const f = await setup(t)
  const verifier = createPauseCapabilityVerifier({
    issuers: f.options.issuers,
    trustedKeys: f.store.authority,
    clock: { wallNow: () => 1000, monotonicNow: () => 1000 },
  })
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1:1'],
  })
  const printerBinding = registry.provision({
    assignment_id: f.f.binding.assignment_id,
    farm_id: f.f.binding.farm_id,
    agent_id: f.f.binding.agent_id,
    printer_key: f.f.capability.printer_key,
    moonraker_origin: 'http://127.0.0.1:1',
  })
  const peer = verifier.createPeer(1)
  async function admit() {
    const admission = verifier.beginAdmission({
      binding: f.f.binding,
      printerBinding,
      peer: peer.peer,
    })
    assert.ok(admission)
    const signed = await caps.signPauseCapability(
      {
        ...f.f.capability,
        kid: 'issuer-2',
        admission_nonce: admission.challenge.admissionNonce,
      },
      f.rotated.privateKey,
    )
    const proof = await caps.signPauseAdmissionProof(
      { ...f.f.challenge, admission_nonce: admission.challenge.admissionNonce },
      f.f.pair.privateKey,
    )
    const control = async (role: 'browser' | 'connector', key: CryptoKey) =>
      controls.encodeControlProof({
        v: 1,
        role,
        binding: f.f.binding,
        signature: await controls.signControlSessionProof(
          f.f.binding,
          role,
          key,
        ),
      })
    return verifier.admit(admission.token, {
      capabilityWire: caps.encodePauseCapability(signed),
      admissionProofWire: caps.encodePauseAdmissionProof(proof),
      browserProofWire: await control('browser', f.f.pair.privateKey),
      connectorProofWire: await control('connector', f.f.connector.privateKey),
    })
  }
  assert.equal((await admit()).ok, false)
  assert.equal(await f.store.confirm(await f.wire(1)), true)
  const accepted = await admit()
  assert.equal(accepted.ok, true)
  if (!accepted.ok) return
  assert.equal(verifier.inspect(accepted.handle).ok, true)
  assert.equal(await f.store.confirm(await f.wire(2, true)), true)
  assert.equal(verifier.inspect(accepted.handle).ok, false)
  assert.equal(accepted.handle.current, undefined)
  assert.equal((await admit()).ok, false)
})

test('queued confirmations cannot roll back and failed persistence denies cached authority', async (t) => {
  const f = await setup(t)
  const [newer, older] = await Promise.all([f.wire(2), f.wire(1)])
  assert.deepEqual(
    await Promise.all([f.store.confirm(newer), f.store.confirm(older)]),
    [true, false],
  )
  assert.equal(f.store.version, 2)
  await rm(f.dir, { recursive: true })
  await assert.rejects(f.store.confirm(await f.wire(3)), {
    message: 'Trusted key storage unavailable',
  })
  assert.equal(f.store.authority.allowsBrowser(f.f.capability), false)
  assert.equal(f.store.authority.issuer('farm:issuer', 'issuer-1'), undefined)
  assert.deepEqual(f.diagnostics, ['trusted-keys-storage-invalid'])
})

test('checkpoint permissions and signature corruption fail closed', async (t) => {
  const f = await setup(t)
  await writeFile(f.path, await f.wire(1), { mode: 0o600 })
  await chmod(f.path, 0o644)
  await assert.rejects(openTrustedKeyStore(f.options), /storage unavailable/)
  await rm(f.path)
  const frame = JSON.parse(await f.wire(1))
  frame.key_set.browser_keys = []
  await writeFile(f.path, encodeTrustedKeySetFrame(frame), { mode: 0o600 })
  await assert.rejects(openTrustedKeyStore(f.options), /storage unavailable/)
})

test('restore epoch ignores persisted authorization and accepts a newly confirmed key set', async (t) => {
  const f = await setup(t)
  assert.equal(await f.store.confirm(await f.wire(500)), true)
  assert.equal(f.store.authority.allowsBrowser(f.f.capability), true)
  execFileSync(process.execPath, [
    'scripts/self-host/restore.ts',
    'fence',
    f.dir,
  ])
  const restored = await openTrustedKeyStore(f.options)
  assert.equal(restored.version, undefined)
  assert.equal(restored.authority.allowsBrowser(f.f.capability), false)
  assert.equal(await restored.confirm(await f.wire(1, true)), true)
  assert.equal(
    (await openTrustedKeyStore(f.options)).authority.allowsBrowser(
      f.f.capability,
    ),
    false,
  )
  assert.equal(await restored.confirm(await f.wire(2)), true)
  assert.equal(
    (await openTrustedKeyStore(f.options)).authority.allowsBrowser(
      f.f.capability,
    ),
    true,
  )
  execFileSync(process.execPath, [
    'scripts/self-host/restore.ts',
    'fence',
    f.dir,
  ])
  assert.equal(
    (await openTrustedKeyStore(f.options)).authority.allowsBrowser(
      f.f.capability,
    ),
    false,
  )
})
