import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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

test('missing hardlink support fails before any network call and leaves no files', async () => {
  const { dir, identity, clock, base } = await setup()
  const link = mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
  })
  syncBuiltinESMExports()
  try {
    const server = fakeServer(identity, [[200, approved]], clock)
    await assert.rejects(
      pairConnector({ ...base, fetch: server.fetch }),
      /EXDEV/,
    )
    assert.deepEqual(server.calls, [])
    assert.deepEqual(readdirSync(dir), ['id'])
  } finally {
    link.mock.restore()
    syncBuiltinESMExports()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-200 response bodies are drained', async () => {
  const { dir, base } = await setup()
  try {
    let drained = 0
    const fetch: PairingFetch = async () => ({
      status: 403,
      text: async () => {
        drained++
        return ''
      },
    })
    await assert.rejects(pairConnector({ ...base, fetch }), /rejected/)
    assert.equal(drained, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function withMocks(run: () => Promise<void>) {
  return async () => {
    try {
      await run()
    } finally {
      mock.restoreAll()
      syncBuiltinESMExports()
    }
  }
}

test(
  'probe unlink failure closes the descriptor, cleans up and keeps the probe error',
  withMocks(async () => {
    const { dir, identity, clock, base } = await setup()
    try {
      const realUnlink = fs.unlinkSync
      const realClose = fs.closeSync
      let probeFailed = false
      let closed = 0
      mock.method(fs, 'unlinkSync', (path: string) => {
        if (path.endsWith('.probe') && !probeFailed) {
          probeFailed = true
          throw Object.assign(new Error('EPERM probe'), { code: 'EPERM' })
        }
        return realUnlink(path)
      })
      mock.method(fs, 'closeSync', (fd: number) => {
        closed++
        if (closed === 1) {
          realClose(fd)
          throw new Error('close failed') // must not mask the probe error
        }
        return realClose(fd)
      })
      syncBuiltinESMExports()
      const server = fakeServer(identity, [[200, approved]], clock)
      await assert.rejects(
        pairConnector({ ...base, fetch: server.fetch }),
        /EPERM probe/,
      )
      assert.equal(closed, 1)
      assert.deepEqual(server.calls, [])
      assert.deepEqual(readdirSync(dir), ['id'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }),
)

test('successful probe leaves no probe file, only the reserved temp file', async () => {
  const { dir, identity, clock, base } = await setup()
  try {
    const server = fakeServer(identity, [[200, approved]], clock)
    let during: string[] = []
    await pairConnector({
      ...base,
      fetch: (url, init) => {
        if (url.endsWith('/start')) during = readdirSync(dir).sort()
        return server.fetch(url, init)
      },
    })
    assert.equal(during.length, 2)
    assert.ok(during.some((n) => /^\.credential-.*\.tmp$/.test(n)))
    assert.ok(!during.some((n) => n.endsWith('.probe')))
    assert.deepEqual(readdirSync(dir).sort(), ['credential.json', 'id'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejecting body on non-200 is swallowed and the status decides the error', async () => {
  const { dir, base } = await setup()
  try {
    const failing =
      (status: number): PairingFetch =>
      async () => ({
        status,
        text: async () => {
          throw new Error('body failed')
        },
      })
    await assert.rejects(
      pairConnector({ ...base, fetch: failing(403) }),
      /rejected/,
    )
    await assert.rejects(
      pairConnector({ ...base, fetch: failing(503) }),
      /unavailable/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an oversized non-200 body via the default transport is cancelled', async () => {
  const { dir, base } = await setup()
  const total = 200
  let sent = 0
  let closedEarly = false
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(403)
    res.on('close', () => {
      closedEarly = sent < total
    })
    const chunk = Buffer.alloc(16_384, 'x')
    const tick = () => {
      if (res.destroyed || sent >= total) return res.end()
      sent++
      res.write(chunk)
      setImmediate(tick)
    }
    tick()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await assert.rejects(
      pairConnector({ ...base, serverOrigin: origin }),
      /rejected/,
    )
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(closedEarly, 'server saw the stream cancelled before completion')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'post-link unlink and directory fsync failures are swallowed with the credential intact',
  withMocks(async () => {
    const { dir, identity, clock, base } = await setup()
    try {
      const realUnlink = fs.unlinkSync
      const realFsync = fs.fsyncSync
      let fsyncs = 0
      mock.method(fs, 'unlinkSync', (path: string) => {
        if (path.endsWith('.tmp')) throw new Error('unlink failed')
        return realUnlink(path)
      })
      mock.method(fs, 'fsyncSync', (fd: number) => {
        if (++fsyncs > 1) throw new Error('fsync failed') // 1st: file, 2nd: directory
        return realFsync(fd)
      })
      syncBuiltinESMExports()
      const server = fakeServer(identity, [[200, approved]], clock)
      const result = await pairConnector({ ...base, fetch: server.fetch })
      assert.equal(result.expiresAt, approved.expires_at)
      assert.equal(fsyncs, 2)
      const stored = JSON.parse(readFileSync(base.credentialPath, 'utf8'))
      assert.equal(stored.approval.agent_id, AGENT)
    } finally {
      mock.restoreAll()
      syncBuiltinESMExports()
      for (const name of readdirSync(dir))
        if (name.endsWith('.tmp')) rmSync(join(dir, name))
      rmSync(dir, { recursive: true, force: true })
    }
  }),
)
