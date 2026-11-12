import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  pairConnector,
  readCredentialStatus,
  type PairingFetch,
} from '../../packages/connector/src/cloud/pairing-client.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { pairingProofPayload } from '../../packages/farm-protocol/src/pairing-proof.ts'

const cli = fileURLToPath(
  new URL('../../packages/connector/src/cli.ts', import.meta.url),
)
const ORIGIN = 'http://127.0.0.1:3000'
const AUDIENCE = 'open3dfarm-test'
const AGENT = '11111111-1111-4111-8111-111111111111'
const FARM = '22222222-2222-4222-8222-222222222222'
const b64 = (n: number) => randomBytes(n).toString('base64url')
const TOKEN = 'aaaa.bbbb.cccc'

/** Fake server: answers per-path with a scripted queue of [status, body]. */
function fakeServer(
  identity: { publicKeySpki: string; fingerprint: string },
  claims: Array<[number, object] | 'throw'>,
  clock: { t: number },
) {
  const calls: string[] = []
  const device = b64(32)
  let challenge: object | undefined
  let signature: string | undefined
  const fetch: PairingFetch = async (url, init) => {
    const path = url.slice(`${ORIGIN}/api/connector-pairing/`.length)
    calls.push(path)
    assert.equal(init.method, 'POST')
    assert.deepEqual(Object.keys(init.headers), ['content-type'])
    const body = JSON.parse(init.body)
    let result: [number, object]
    if (path === 'start') {
      result = [
        200,
        {
          device_code: device,
          user_code: 'BCDFGHJK',
          fingerprint: identity.fingerprint,
          issued_at: clock.t,
          expires_at: clock.t + 15 * 60_000,
          poll_interval_s: 5,
        },
      ]
    } else if (path === 'challenge') {
      assert.equal(body.device_code, device)
      challenge = {
        v: 1,
        agent_id: AGENT,
        public_key_spki: identity.publicKeySpki,
        fingerprint: identity.fingerprint,
        origin: ORIGIN,
        audience: AUDIENCE,
        nonce: b64(32),
        issued_at: clock.t,
        expires_at: clock.t + 60_000,
      }
      result = [200, challenge]
    } else if (path === 'proof') {
      signature = body.signature
      const ok = verify(
        null,
        pairingProofPayload(body.challenge),
        createPublicKey({
          key: Buffer.from(identity.publicKeySpki, 'base64url'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(body.signature, 'base64url'),
      )
      assert.ok(ok)
      result = [
        200,
        {
          status: 'verified',
          agentId: AGENT,
          fingerprint: identity.fingerprint,
        },
      ]
    } else {
      const next = claims.shift()
      if (next === 'throw') throw new Error('network')
      result = next ?? [200, { status: 'pending', retry_after_s: 5 }]
    }
    return { status: result[0], text: async () => JSON.stringify(result[1]) }
  }
  return { fetch, calls, signature: () => signature }
}
const approved = {
  status: 'approved',
  agent_id: AGENT,
  farm_id: FARM,
  device_token: TOKEN,
  expires_at: Date.now() + 3_600_000,
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-pair-'))
  const identity = loadOrCreateIdentity(join(dir, 'id'))
  const clock = { t: Date.now() }
  const sleeps: number[] = []
  const base = {
    serverOrigin: ORIGIN,
    audience: AUDIENCE,
    identity,
    credentialPath: join(dir, 'credential.json'),
    signal: new AbortController().signal,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock.t += ms
    },
    onCode: () => {},
  }
  return { dir, identity, clock, sleeps, base }
}

test('pair proves key possession, waits through pending/slow_down and stores a private credential', async () => {
  const { dir, identity, clock, sleeps, base } = await setup()
  try {
    const server = fakeServer(
      identity,
      [
        [200, { status: 'pending', retry_after_s: 5 }],
        [200, { status: 'slow_down', retry_after_s: 20 }],
        'throw',
        [200, approved],
      ],
      clock,
    )
    const shown: unknown[] = []
    const result = await pairConnector({
      ...base,
      fetch: server.fetch,
      onCode: (code) => shown.push({ ...code, calls: [...server.calls] }),
    })
    assert.equal(result.expiresAt, approved.expires_at)
    // Code is shown only after the proof, with the locally derived fingerprint.
    assert.deepEqual(shown, [
      {
        userCode: 'BCDF-GHJK',
        fingerprint: identity.fingerprint,
        calls: ['start', 'challenge', 'proof'],
      },
    ])
    // poll 5s, pending 5s, slow_down 20s, transient backoff 1s, then approved.
    assert.deepEqual(sleeps, [5000, 5000, 20000, 1000])
    const path = base.credentialPath
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const status = readCredentialStatus(path, identity.fingerprint, clock.t)
    assert.equal(status.valid, true)
    assert.equal(status.agentId, AGENT)
    assert.ok(!JSON.stringify(status).includes(TOKEN))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pair fails closed: denied, rejection, wrong audience, existing credential, fingerprint mismatch', async () => {
  const { dir, identity, clock, base } = await setup()
  try {
    await assert.rejects(
      pairConnector({
        ...base,
        fetch: fakeServer(identity, [[200, { status: 'denied' }]], clock).fetch,
      }),
      /denied/,
    )
    await assert.rejects(
      pairConnector({
        ...base,
        fetch: fakeServer(identity, [[403, {}]], clock).fetch,
      }),
      /rejected/,
    )
    await assert.rejects(
      pairConnector({
        ...base,
        audience: 'other-audience',
        fetch: fakeServer(identity, [], clock).fetch,
      }),
      /not current or trusted/,
    )
    const mismatch = fakeServer(
      { ...identity, fingerprint: 'SHA256:' + 'A'.repeat(43) },
      [],
      clock,
    )
    await assert.rejects(
      pairConnector({ ...base, fetch: mismatch.fetch }),
      /mismatch/,
    )
    writeFileSync(base.credentialPath, 'keep', { mode: 0o600 })
    const untouched = fakeServer(identity, [[200, approved]], clock)
    await assert.rejects(
      pairConnector({ ...base, fetch: untouched.fetch }),
      /already exists/,
    )
    assert.deepEqual(untouched.calls, []) // detected before any network call
    assert.equal(readFileSync(base.credentialPath, 'utf8'), 'keep')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pair gives up after bounded transient failures and times out at the pairing deadline', async () => {
  const { dir, identity, clock, sleeps, base } = await setup()
  try {
    const down: PairingFetch = async () => ({
      status: 503,
      text: async () => '',
    })
    await assert.rejects(pairConnector({ ...base, fetch: down }), /unavailable/)
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000])
    const server = fakeServer(identity, [], clock) // pending forever
    await assert.rejects(
      pairConnector({ ...base, fetch: server.fetch }),
      /proof expired/,
    )
    // 60 s proof lifetime at a 5 s interval: bounded, not the 15 min pairing TTL.
    assert.ok(server.calls.filter((c) => c === 'claim').length <= 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status CLI prints local identity and credential metadata without secrets', async () => {
  const { dir, identity, clock, base } = await setup()
  try {
    await pairConnector({
      ...base,
      fetch: fakeServer(identity, [[200, approved]], clock).fetch,
    })
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        timeout: 5000,
      })
    const ok = run(
      'status',
      '--data-dir',
      join(dir, 'id'),
      '--credential-file',
      base.credentialPath,
    )
    assert.equal(ok.status, 0, ok.stderr)
    const out = JSON.parse(ok.stdout)
    assert.equal(out.fingerprint, identity.fingerprint)
    assert.equal(out.credential.valid, true)
    assert.ok(!ok.stdout.includes(TOKEN))
    const none = run(
      'status',
      '--data-dir',
      join(dir, 'id'),
      '--credential-file',
      join(dir, 'absent'),
    )
    assert.deepEqual(JSON.parse(none.stdout).credential, {
      present: false,
      valid: false,
    })
    assert.equal(run('status').status, 1)
    assert.equal(run('pair', '--server', ORIGIN).status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('credential write is checked up front and leaves no partial files', async () => {
  const { dir, identity, clock, base } = await setup()
  try {
    const names = () => readdirSync(dir).sort()
    // Unsafe parent directory: rejected before any network call.
    chmodSync(dir, 0o777)
    const unsafe = fakeServer(identity, [], clock)
    await assert.rejects(
      pairConnector({ ...base, fetch: unsafe.fetch }),
      /not writable by others/,
    )
    assert.deepEqual(unsafe.calls, [])
    chmodSync(dir, 0o700)
    assert.deepEqual(names(), ['id'])
    // Final path appears during pairing: link fails, temp file removed, other file kept.
    const server = fakeServer(identity, [[200, approved]], clock)
    await assert.rejects(
      pairConnector({
        ...base,
        fetch: (url, init) => {
          if (url.endsWith('/claim'))
            writeFileSync(base.credentialPath, 'other', { mode: 0o600 })
          return server.fetch(url, init)
        },
      }),
      /EEXIST/,
    )
    assert.deepEqual(names(), ['credential.json', 'id'])
    assert.equal(readFileSync(base.credentialPath, 'utf8'), 'other')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pair rejects an approval for a different agent and leaves no file', async () => {
  const { dir, identity, clock, base } = await setup()
  try {
    const server = fakeServer(
      identity,
      [[200, { ...approved, agent_id: FARM }]],
      clock,
    )
    await assert.rejects(
      pairConnector({ ...base, fetch: server.fetch }),
      /agent mismatch/,
    )
    assert.deepEqual(readdirSync(dir), ['id'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default transport caps response size by header and by stream', async () => {
  const { dir, base } = await setup()
  const big = 'x'.repeat(20_000)
  const server = createServer((req, res) => {
    req.resume()
    if (req.url?.includes('chunked')) {
      res.write(big.slice(0, 10_000)) // no content-length
      res.end(big.slice(10_000))
    } else res.end(big) // content-length 20000
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await assert.rejects(
      pairConnector({ ...base, serverOrigin: origin }),
      /Pairing request failed/,
    )
    const rewrite = (url: string) =>
      url.replace('/api/connector-pairing/', '/chunked/')
    const nativeFetch = globalThis.fetch
    globalThis.fetch = ((url: string, init: RequestInit) =>
      nativeFetch(rewrite(url), init)) as typeof fetch
    try {
      await assert.rejects(
        pairConnector({ ...base, serverOrigin: origin }),
        /Invalid pairing response/,
      )
    } finally {
      globalThis.fetch = nativeFetch
    }
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
