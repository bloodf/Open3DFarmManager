// Built farm server + caller-owned disposable PostgreSQL + real Connector renewal
// over HTTPS. All rows synthetic; no hardware, no shared database.
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID, createPublicKey } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { writeCredentialFileAtomically } from '../../packages/connector/src/cloud/credential-renewal.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'

const TTL = 20
const KID = 'renewal-https'
const AUDIENCE = 'open3dfarmmanager:connector'
const PROOF_AUDIENCE = 'open3dfarmmanager:renewal'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** TLS-terminating loopback proxy that records renewal modes and can drop one reply. */
function proxy(key: Buffer, cert: Buffer, upstreamPort: number) {
  const seen: { path: string; mode: string | null }[] = []
  let dropNextComplete = false
  const server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      let mode: string | null = null
      try {
        const value = JSON.parse(body.toString('utf8'))
        mode = value?.mode ?? value?.request?.mode ?? null
      } catch {
        /* not JSON */
      }
      seen.push({ path: req.url ?? '', mode })
      const drop =
        dropNextComplete &&
        req.url === '/api/connector/credentials/renewal/complete'
      const upstream = request(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (reply) => {
          if (drop && reply.statusCode === 200) {
            dropNextComplete = false
            reply.resume()
            reply.once('end', () => res.destroy())
            return
          }
          res.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(res)
        },
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      upstream.end(body)
    })
  })
  return {
    server,
    seen,
    dropNextComplete: () => {
      dropNextComplete = true
    },
  }
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const done = await Promise.race([
    exited.then(() => true),
    sleep(5000).then(() => false),
  ])
  if (!done) {
    child.kill('SIGKILL')
    await exited
  }
}

export async function testRenewalHttps(
  admin: Sql,
  databasePort: number,
  ports: { app: number; proxy: number },
): Promise<string[]> {
  const checks: string[] = []
  const role = 'renewal_https_' + randomUUID().replaceAll('-', '')
  const secret = randomBytes(24).toString('hex')
  await admin.unsafe(
    `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_credential_renewer`,
  )
  const directory = await mkdtemp(join(tmpdir(), 'o3dfm-renewal-https-'))
  await chmod(directory, 0o700)
  let app: ChildProcess | undefined
  let tls: ReturnType<typeof proxy> | undefined
  try {
    const cert = join(directory, 'cert.pem'),
      tlsKey = join(directory, 'tls-key.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        tlsKey,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    )
    const origin = `https://127.0.0.1:${ports.proxy}`
    // Server signing key (PKCS8, private) and public registry for parent verification.
    const signing = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const pkcs8 = Buffer.from(
      await crypto.subtle.exportKey('pkcs8', signing.privateKey),
    )
    const keyPath = join(directory, 'signing.pem'),
      registryPath = join(directory, 'registry.json')
    await writeFile(
      keyPath,
      `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64')}\n-----END PRIVATE KEY-----\n`,
      { mode: 0o600 },
    )
    await writeFile(
      registryPath,
      JSON.stringify({
        [KID]: createPublicKey({
          key: Buffer.from(
            await crypto.subtle.exportKey('spki', signing.publicKey),
          ),
          format: 'der',
          type: 'spki',
        }).export({ type: 'spki', format: 'pem' }),
      }),
      { mode: 0o600 },
    )

    // Synthetic enrollment and root credential through the official pairing store.
    const data = join(directory, 'connector')
    const identity = loadOrCreateIdentity(data)
    const farmId = randomUUID(),
      accountId = randomUUID(),
      t0 = Date.now()
    await admin`INSERT INTO farm.session_accounts(id) VALUES(${accountId})`
    await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${accountId},'owner')`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${accountId},${accountId},0,${t0},${t0},${t0 + 2000000})`
    const pairingConfig = { origin, audience: 'open3dfarmmanager:pairing' }
    const pairing = new PostgresPairing(admin, pairingConfig),
      proofs = new PostgresPairingProof(admin, pairingConfig)
    const started = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    if (!started.ok) throw new Error('Pairing start failed')
    const proof = await proofs.issue({
      device_code: started.response.device_code,
    })
    if (!proof.ok) throw new Error('Pairing proof failed')
    assert.equal(
      (
        await proofs.complete({
          device_code: started.response.device_code,
          challenge: proof.challenge,
          signature: identity.signPairingProof({
            challenge: proof.challenge,
            expectedOrigin: origin,
            expectedAudience: pairingConfig.audience,
            now: Date.now(),
          }),
        })
      ).ok,
      true,
    )
    assert.equal(
      (
        await pairing.decide({
          sessionRecordId: accountId,
          policy: { idleTimeoutMs: 2000000 },
          decision: 'approve',
          request: {
            user_code: started.response.user_code,
            farm_id: farmId,
            expected_fingerprint: identity.fingerprint,
          },
        })
      ).ok,
      true,
    )

    // Built server: database gate verifies the schema; renewal is its own opt-in.
    const adminUrl = `postgres://fixture:unused@127.0.0.1:${databasePort}/fixture`
    app = spawn('node', ['apps/farm/.output/server/index.mjs'], {
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(ports.app),
        NUXT_DATABASE_ENABLED: 'true',
        NUXT_DATABASE_DATABASE_URL: adminUrl,
        NUXT_DATABASE_MIGRATIONS: 'verify',
        NUXT_DATABASE_MIGRATIONS_DIR: join(
          process.cwd(),
          'infra/db/migrations',
        ),
        NUXT_CONNECTOR_RENEWAL_ENABLED: 'true',
        NUXT_CONNECTOR_RENEWAL_DATABASE_URL: `postgres://${role}:${secret}@127.0.0.1:${databasePort}/fixture`,
        NUXT_CONNECTOR_RENEWAL_ORIGIN: origin,
        NUXT_CONNECTOR_RENEWAL_ISSUER: origin,
        NUXT_CONNECTOR_RENEWAL_AUDIENCE: AUDIENCE,
        NUXT_CONNECTOR_RENEWAL_PROOF_AUDIENCE: PROOF_AUDIENCE,
        NUXT_CONNECTOR_RENEWAL_SIGNING_KEY_ID: KID,
        NUXT_CONNECTOR_RENEWAL_SIGNING_KEY_PATH: keyPath,
        NUXT_CONNECTOR_RENEWAL_PUBLIC_KEY_REGISTRY_PATH: registryPath,
        NUXT_CONNECTOR_RENEWAL_TOKEN_TTL_SECONDS: String(TTL),
        NUXT_CONNECTOR_RENEWAL_PROOF_TTL_MS: '30000',
        NUXT_CONNECTOR_RENEWAL_BODY_TIMEOUT_MS: '5000',
      },
    })
    const deadline = Date.now() + 30000
    while (true) {
      if (app.exitCode !== null) throw new Error('Built app exited at startup')
      const ready = await fetch(`http://127.0.0.1:${ports.app}/readyz`).then(
        (r) => r.ok,
        () => false,
      )
      if (ready) break
      if (Date.now() >= deadline) throw new Error('Built app never ready')
      await sleep(200)
    }
    checks.push('built farm server passed the database readiness gate')

    tls = proxy(await readFile(tlsKey), await readFile(cert), ports.app)
    tls.server.listen(ports.proxy, '127.0.0.1')
    await once(tls.server, 'listening')

    // Root credential signed with the server's renewal key, issued now.
    const claim = await pairing.claim(
      { device_code: started.response.device_code },
      {
        issuer: origin,
        audience: AUDIENCE,
        kid: KID,
        ttlSeconds: TTL,
        privateKey: signing.privateKey,
      },
    )
    if (!claim.ok || claim.status !== 'approved')
      throw new Error('Root claim failed')
    const credentialPath = join(directory, 'credential.json')
    writeCredentialFileAtomically(credentialPath, {
      version: 1,
      expected_fingerprint: identity.fingerprint,
      approval: {
        status: 'approved',
        agent_id: claim.agent_id,
        farm_id: claim.farm_id,
        device_token: claim.device_token,
        expires_at: claim.expires_at,
      },
    })
    const credential = async () =>
      JSON.parse(await readFile(credentialPath, 'utf8')) as {
        root_jti?: string
        approval: { device_token: string; expires_at: number }
      }
    const connector = async (step: 'renew' | 'startup') => {
      const child = spawn(
        'node',
        ['tests/helpers/renewal-https-connector-child.ts'],
        {
          stdio: ['ignore', 'pipe', 'inherit'],
          env: {
            PATH: process.env.PATH,
            NODE_EXTRA_CA_CERTS: cert,
            RENEWAL_HTTPS_CHILD: JSON.stringify({
              step,
              credentialPath,
              dataDirectory: data,
              origin,
              audience: PROOF_AUDIENCE,
            }),
          },
        },
      )
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk))
      await once(child, 'exit')
      return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
        result: string
        name?: string
        diagnostics?: string[]
      }
    }
    const successors = async () =>
      (
        await admin`SELECT s.jti::text FROM farm.connector_credential_successors s JOIN farm.connector_credentials r ON r.jti=s.root_jti WHERE r.agent_id=${claim.agent_id}::uuid ORDER BY s.ordinal`
      ).map((row) => row.jti as string)

    const root = await credential()
    assert.deepEqual(await connector('renew'), { result: 'renewed' })
    const first = await credential()
    assert.notEqual(first.approval.device_token, root.approval.device_token)
    assert.ok(first.root_jti)
    assert.equal((await successors()).length, 1)
    checks.push(
      'real Connector renewed its root over HTTPS against the built server',
    )

    // Successor expiry must exceed the parent's (1 s claim resolution).
    await sleep(1100)
    tls.dropNextComplete()
    assert.equal((await connector('renew')).result, 'error')
    assert.deepEqual(await credential(), first)
    assert.equal((await successors()).length, 2)
    checks.push(
      'reply lost after server commit: Connector kept its current credential',
    )

    // Restart after the local credential expired: readback only, never issue.
    await sleep(Math.max(0, first.approval.expires_at - Date.now() + 1000))
    const issuesBefore = tls.seen.filter((s) => s.mode === 'issue').length
    const recovered = await connector('startup')
    assert.deepEqual(recovered.result, 'recovered', JSON.stringify(recovered))
    assert.deepEqual(recovered.diagnostics, ['credential-recovered'])
    const second = await credential()
    assert.ok(second.approval.expires_at > Date.now())
    assert.equal(second.root_jti, first.root_jti)
    assert.equal(
      tls.seen.filter((s) => s.mode === 'issue').length,
      issuesBefore,
    )
    assert.equal((await successors()).length, 2)
    checks.push(
      'startup with expired credential recovered the committed successor by readback only',
    )

    // Expired with nothing committed: fail closed, require re-pairing.
    await sleep(Math.max(0, second.approval.expires_at - Date.now() + 1000))
    assert.deepEqual(await connector('startup'), {
      result: 'error',
      name: 'CredentialRepairRequired',
    })
    assert.deepEqual(await credential(), second)
    assert.equal(
      tls.seen.filter((s) => s.mode === 'issue').length,
      issuesBefore,
    )
    assert.equal((await successors()).length, 2)
    checks.push(
      'startup with expired credential and no committed successor fails closed (re-pair)',
    )
    return checks
  } finally {
    if (tls) {
      tls.server.closeAllConnections()
      await new Promise<void>((resolve) => tls!.server.close(() => resolve()))
    }
    await stop(app)
    await rm(directory, { recursive: true, force: true })
    await admin.unsafe(`DROP OWNED BY ${role}`)
    await admin.unsafe(`DROP ROLE ${role}`)
  }
}
