import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import postgres from 'postgres'
import {
  validateKobraXTargetInput,
  describeConfigurationError,
} from '../../apps/farm/app/utils/kobralink-onboarding.ts'
import {
  buildKobraCertTargetOption,
  processSelectedKobraCertFiles,
  sanitizeTargetForClientStorage,
} from '../../apps/farm/app/utils/kobra-client-cert-ui.ts'
import { formatPrinterStateLabel } from '../../apps/farm/app/utils/farm-view.ts'
import { PostgresConfigurationStore } from '../../apps/farm/server/storage/postgres-configuration.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { createConfigurationRegistrationService } from '../../apps/farm/server/services/configuration-receipt-registration.ts'
import {
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import {
  assignmentKobraCertPath,
  importKobraClientCertFromInput,
  kobraClientCertPath,
  readKobraClientCertMaterial,
  stagedKobraCertPath,
} from '../../packages/connector/src/config/kobra-x-cert.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  createProvisioningEngine,
  provisioningRequestFromEvidence,
  trustProvisioningAuthority,
} from '../../packages/connector/src/provisioning/index.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { connectorFingerprintFromSpki } from '../../packages/farm-protocol/src/configuration-binding.ts'
import { deriveConfigurationAssignmentIdentity } from '../../packages/farm-protocol/src/configuration-inventory.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { validateKobraClientCertificate } from '../../packages/shared/src/kobra-client-cert.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'

const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'e16-366-')))
const pgControl = { dataDir: '', sockDir: '' }

after(() => {
  if (pgControl.dataDir) {
    try {
      execFileSync('/opt/homebrew/bin/pg_ctl', [
        '-D',
        pgControl.dataDir,
        '-m',
        'immediate',
        'stop',
      ])
    } catch {}
  }
  rmSync(workDir, { recursive: true, force: true })
})

function openssl(args) {
  return execFileSync('openssl', args, { encoding: 'utf8' })
}

function generateTestCerts() {
  const dir = join(workDir, 'certs')
  mkdirSync(dir, { recursive: true })
  const validKey = join(dir, 'valid.key')
  const validCert = join(dir, 'valid.crt')
  openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=AnycubicSlicer',
    '-days',
    '30',
    '-keyout',
    validKey,
    '-out',
    validCert,
  ])

  const combinedPem = join(dir, 'combined.pem')
  const validCertPem = readFileSync(validCert, 'utf8')
  const validKeyPem = readFileSync(validKey, 'utf8')
  writeFileSync(combinedPem, `${validCertPem}\n${validKeyPem}`)

  const validP12 = join(dir, 'valid.p12')
  openssl([
    'pkcs12',
    '-export',
    '-inkey',
    validKey,
    '-in',
    validCert,
    '-passout',
    'pass:slicer-test-pass',
    '-out',
    validP12,
  ])

  const wrongSubjectKey = join(dir, 'wrong-subj.key')
  const wrongSubjectCert = join(dir, 'wrong-subj.crt')
  openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=NotAnycubic',
    '-days',
    '30',
    '-keyout',
    wrongSubjectKey,
    '-out',
    wrongSubjectCert,
  ])

  const caKey = join(dir, 'ca.key')
  const caCert = join(dir, 'ca.crt')
  const expiredKey = join(dir, 'expired.key')
  const expiredCsr = join(dir, 'expired.csr')
  const expiredCert = join(dir, 'expired.crt')
  const serialFile = join(dir, 'ca.srl')
  openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=TestCA',
    '-days',
    '365',
    '-keyout',
    caKey,
    '-out',
    caCert,
  ])
  openssl([
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=AnycubicSlicer',
    '-keyout',
    expiredKey,
    '-out',
    expiredCsr,
  ])
  openssl([
    'ca',
    '-batch',
    '-notext',
    '-create_serial',
    '-rand_serial',
    '-config',
    writeOpenSslCaConfig(dir, caCert, caKey, serialFile),
    '-startdate',
    '20200101000000Z',
    '-enddate',
    '20210101000000Z',
    '-in',
    expiredCsr,
    '-out',
    expiredCert,
  ])

  const corruptFile = join(dir, 'corrupt.pem')
  writeFileSync(corruptFile, 'not a valid pem or pkcs12 file')

  return {
    dir,
    validKey,
    validCert,
    validCertPem,
    validKeyPem,
    combinedPem,
    validP12,
    validP12Bytes: readFileSync(validP12),
    wrongSubjectPem: `${readFileSync(wrongSubjectCert, 'utf8')}\n${readFileSync(wrongSubjectKey, 'utf8')}`,
    expiredPem: `${readFileSync(expiredCert, 'utf8')}\n${readFileSync(expiredKey, 'utf8')}`,
    corruptBytes: readFileSync(corruptFile),
  }
}

function writeOpenSslCaConfig(dir, caCert, caKey, serialFile) {
  const dbIndex = join(dir, 'index.txt')
  const newCerts = join(dir, 'newcerts')
  mkdirSync(newCerts, { recursive: true })
  writeFileSync(dbIndex, '')
  const confPath = join(dir, 'openssl-ca.cnf')
  writeFileSync(
    confPath,
    `[ ca ]
default_ca = CA_default

[ CA_default ]
dir = ${dir}
database = ${dbIndex}
new_certs_dir = ${newCerts}
certificate = ${caCert}
serial = ${serialFile}
private_key = ${caKey}
default_md = sha256
policy = policy_any
unique_subject = no

[ policy_any ]
commonName = supplied
`,
  )
  return confPath
}

function syntheticBridge(lan = { '192.168.1.50': 'kx-0001' }) {
  const printers = []
  const users = []
  const tokens = new Set()
  let needsSetup = true
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const session = () => {
    const token = randomUUID()
    tokens.add(token)
    return new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'set-cookie': `better-auth.session_token=${token}; HttpOnly; Path=/`,
      },
    })
  }
  const authed = (init) => {
    const cookie = String(init.headers?.Cookie ?? '').split('=')[1]
    return cookie !== undefined && tokens.has(cookie)
  }
  const wire = (p) => ({
    ...p,
    username: 'mqtt-user',
    model: 'Kobra X',
    live: null,
  })
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url)
    const method = init.method ?? 'GET'
    if (pathname === '/api/v1/setup/status') return json({ needsSetup })
    if (pathname === '/api/auth/sign-up/email') {
      const body = JSON.parse(String(init.body))
      users.push({ email: body.email, password: body.password })
      needsSetup = false
      return session()
    }
    if (pathname === '/api/auth/sign-in/email') {
      const body = JSON.parse(String(init.body))
      return users.some(
        (u) => u.email === body.email && u.password === body.password,
      )
        ? session()
        : json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, 401)
    }
    if (!authed(init)) return json({ message: 'unauthorized' }, 401)
    if (pathname === '/api/v1/printers' && method === 'GET') {
      return json(printers.map(wire))
    }
    if (pathname === '/api/v1/printers' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      const deviceId = lan[body.ip]
      if (!deviceId) return json({ message: 'unreachable' }, 503)
      const created = {
        id: `p${printers.length + 1}`,
        deviceId,
        ip: body.ip,
        name: body.name,
      }
      printers.push(created)
      return json(wire(created))
    }
    const match = /^\/api\/v1\/printers\/([A-Za-z0-9_-]+)$/.exec(pathname)
    const found = printers.find((p) => p.id === match?.[1])
    if (match && !found) return json({ message: 'missing' }, 404)
    if (match && found && method === 'GET') return json(wire(found))
    return json({}, 404)
  }
  return { fetch, printers }
}

const certs = generateTestCerts()

test('validates PEM & PKCS#12 Kobra X client certificates and reports clear errors', async () => {
  const pemOk = await validateKobraClientCertificate({
    text: `${certs.validCertPem}\n${certs.validKeyPem}`,
  })
  assert.equal(pemOk.ok, true)
  assert.equal(pemOk.format, 'pem')
  assert.equal(pemOk.metadata.commonName, 'AnycubicSlicer')
  assert.match(pemOk.metadata.subject, /CN=AnycubicSlicer/)

  const uiPem = await processSelectedKobraCertFiles({
    files: [
      { name: 'client.crt', bytes: readFileSync(certs.validCert) },
      { name: 'client.key', bytes: readFileSync(certs.validKey) },
    ],
  })
  assert.equal(uiPem.ok, true)
  assert.equal(uiPem.summary.commonName, 'AnycubicSlicer')
  assert.equal(uiPem.summary.format, 'pem')

  const uiP12 = await processSelectedKobraCertFiles({
    files: [{ name: 'slicer.p12', bytes: certs.validP12Bytes }],
    passphrase: 'slicer-test-pass',
  })
  assert.equal(uiP12.ok, true)
  assert.equal(uiP12.summary.format, 'pkcs12')
  assert.equal(uiP12.summary.commonName, 'AnycubicSlicer')

  const wrongPass = await processSelectedKobraCertFiles({
    files: [{ name: 'slicer.p12', bytes: certs.validP12Bytes }],
    passphrase: 'wrong-password',
  })
  assert.equal(wrongPass.ok, false)
  assert.equal(wrongPass.reason, 'unreadable')

  const missingUi = await processSelectedKobraCertFiles({ files: [] })
  assert.equal(missingUi.ok, false)
  assert.equal(missingUi.reason, 'missing')
  assert.match(missingUi.error, /client certificate missing/i)

  const unreadableUi = await processSelectedKobraCertFiles({
    files: [{ name: 'bad.pem', bytes: certs.corruptBytes }],
  })
  assert.equal(unreadableUi.ok, false)
  assert.equal(unreadableUi.reason, 'unreadable')

  const wrongSubject = await processSelectedKobraCertFiles({
    files: [
      {
        name: 'wrong.pem',
        bytes: Buffer.from(certs.wrongSubjectPem, 'utf8'),
      },
    ],
  })
  assert.equal(wrongSubject.ok, false)
  assert.equal(wrongSubject.reason, 'wrong-subject')
  assert.match(wrongSubject.error, /wrong subject/i)

  const expired = await processSelectedKobraCertFiles({
    files: [
      {
        name: 'expired.pem',
        bytes: Buffer.from(certs.expiredPem, 'utf8'),
      },
    ],
  })
  assert.equal(expired.ok, false)
  assert.equal(expired.reason, 'expired')
  assert.match(expired.error, /expired/i)

  const targetWithCert = validateKobraXTargetInput({
    ipv4: '192.168.1.50',
    displayLabel: 'Kobra X',
    clientCertificate: uiPem.payload,
  })
  assert.equal(targetWithCert.ok, true)
  const sanitized = sanitizeTargetForClientStorage(targetWithCert.target)
  assert.equal(JSON.stringify(sanitized).includes(certs.validKeyPem), false)
  assert.equal('client_certificate' in sanitized, false)

  const emptyPath = buildKobraCertTargetOption({
    source: 'install-path',
    installPath: '   ',
    inlinePayload: null,
    certError: '',
  })
  assert.equal(emptyPath.ok, false)
  assert.match(emptyPath.error, /client certificate missing/i)
})

test('Connector imports from Anycubic Slicer Next install path and rejects symlinks/missing/bad certs', async () => {
  const macAppDir = join(workDir, 'AnycubicSlicerNext.app')
  const macResDir = join(macAppDir, 'Contents', 'Resources', 'certs')
  mkdirSync(macResDir, { recursive: true })
  writeFileSync(join(macResDir, 'client.crt'), certs.validCertPem)
  writeFileSync(join(macResDir, 'client.key'), certs.validKeyPem)

  const fromMacInstall = await importKobraClientCertFromInput({
    kind: 'install-path',
    path: macAppDir,
  })
  assert.equal(fromMacInstall.ok, true)
  assert.equal(fromMacInstall.cert.commonName, 'AnycubicSlicer')

  const directFile = await importKobraClientCertFromInput({
    kind: 'install-path',
    path: join(macResDir, 'client.crt'),
  })
  assert.equal(directFile.ok, true)

  const missingDir = await importKobraClientCertFromInput({
    kind: 'install-path',
    path: join(workDir, 'does-not-exist'),
  })
  assert.equal(missingDir.ok, false)
  assert.equal(missingDir.reason, 'missing')

  const symlinkPath = join(workDir, 'cert-symlink.pem')
  symlinkSync(certs.combinedPem, symlinkPath)
  const fromSymlink = await importKobraClientCertFromInput({
    kind: 'install-path',
    path: symlinkPath,
  })
  assert.equal(fromSymlink.ok, false)
  assert.equal(fromSymlink.reason, 'unreadable')
})

test('Connector config-v1 provisioning stores cert 0600, redacts journal, and rejects invalid certs', async () => {
  const ids = {
    farm: '22222222-2222-4222-8222-222222222222',
    agent: '33333333-3333-4333-8333-333333333333',
    key: '44444444-4444-4444-8444-444444444444',
    jti: '55555555-5555-4555-8555-555555555555',
    transport: '11111111-1111-4111-8111-111111111111',
  }
  const provDir = join(workDir, 'prov-engine')
  const stateDir = join(provDir, 'state')
  const runtimePath = join(provDir, 'runtime.json')
  mkdirSync(provDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    runtimePath,
    JSON.stringify({
      version: 1,
      collection: { version: 1, allowedOrigins: [], printers: [] },
      assignments: [],
      telemetry: {
        endpoint: 'https://farm.example/telemetry',
        audience: 'test',
      },
    }),
    { mode: 0o600 },
  )
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = base64url(
    new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
  )
  const fingerprint = await connectorFingerprintFromSpki(spki)
  const bridge = syntheticBridge({ '192.168.1.50': 'kx-0001' })
  const authority = trustProvisioningAuthority({
    async isCurrent() {
      return true
    },
    async acceptsInventoryAck() {
      return true
    },
  })
  const engine = createProvisioningEngine({
    stateDirectory: stateDir,
    runtime: {
      runtimeConfigPath: runtimePath,
      agent_id: ids.agent,
      farm_id: ids.farm,
    },
    connector: { fingerprint, receiptKey: keys.privateKey },
    authority,
    managedBridge: {
      origin: 'http://127.0.0.1:7100',
      ownership: 'connector-owned-fresh',
    },
    printerNetworks: ['192.168.1.0/24'],
    fetch: bridge.fetch,
  })
  let nonce = 1
  const makeContext = (action) => ({
    account_id: 'account_1',
    role: 'owner',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
    credential_jti: ids.jti,
    transport_id: ids.transport,
    connector_fingerprint: fingerprint,
    capability_id: randomUUID(),
    admission_nonce: base64url(new Uint8Array(32).fill(++nonce % 250)),
    action,
  })

  // Error cases first: wrong-subject, expired, unreadable, missing path
  for (const [label, clientCertificate, expectedError] of [
    [
      'wrong-subject',
      {
        kind: 'inline',
        format: 'pem',
        certificate_pem: readFileSync(
          join(certs.dir, 'wrong-subj.crt'),
          'utf8',
        ),
        key_pem: readFileSync(join(certs.dir, 'wrong-subj.key'), 'utf8'),
      },
      'client-cert-wrong-subject',
    ],
    [
      'expired',
      {
        kind: 'inline',
        format: 'pem',
        certificate_pem: readFileSync(join(certs.dir, 'expired.crt'), 'utf8'),
        key_pem: readFileSync(join(certs.dir, 'expired.key'), 'utf8'),
      },
      'client-cert-expired',
    ],
    [
      'unreadable',
      {
        kind: 'inline',
        format: 'pkcs12',
        pkcs12_base64: certs.validP12Bytes.toString('base64'),
        passphrase: 'bad-password',
      },
      'client-cert-unreadable',
    ],
    [
      'missing',
      {
        kind: 'install-path',
        path: join(workDir, 'missing-slicer-install'),
      },
      'client-cert-missing',
    ],
  ]) {
    const badOp = randomUUID()
    const badRes = await engine.handle({
      frame: {
        v: 1,
        protocol: 'config-v1',
        type: 'prepare',
        request_id: randomUUID(),
        operation_id: badOp,
        expected_revision: 0,
        target: {
          v: 1,
          protocol: 'config-v1',
          backend: 'kobralink-anycubic',
          model: { family: 'anycubic-kobra-x', provisional: true },
          endpoint: { ipv4: '192.168.1.50', port: 18910 },
          bridge: { kind: 'connector-managed' },
          client_certificate: clientCertificate,
        },
      },
      context: makeContext('prepare'),
    })
    assert.equal(badRes.type, 'error', `expected error for ${label}`)
    assert.equal(badRes.code, expectedError)
    assert.equal(existsSync(stagedKobraCertPath(stateDir, badOp)), false)
    assert.match(
      describeConfigurationError(badRes.code),
      new RegExp(
        expectedError.replace('client-cert-', '').replace('-', ' '),
        'i',
      ),
    )
  }

  // Happy path with PKCS#12 client cert
  const opId = randomUUID()
  const target = {
    v: 1,
    protocol: 'config-v1',
    backend: 'kobralink-anycubic',
    model: { family: 'anycubic-kobra-x', provisional: true },
    endpoint: { ipv4: '192.168.1.50', port: 18910 },
    bridge: { kind: 'connector-managed' },
    client_certificate: {
      kind: 'inline',
      format: 'pkcs12',
      pkcs12_base64: certs.validP12Bytes.toString('base64'),
      passphrase: 'slicer-test-pass',
    },
  }
  const targetSha256 = await configurationTargetHash(target)
  const prepRes = await engine.handle({
    frame: {
      v: 1,
      protocol: 'config-v1',
      type: 'prepare',
      request_id: randomUUID(),
      operation_id: opId,
      expected_revision: 0,
      target,
    },
    context: makeContext('prepare'),
  })
  assert.equal(prepRes.type, 'result')
  assert.equal(prepRes.state, 'prepared')
  const staged = stagedKobraCertPath(stateDir, opId)
  assert.equal(existsSync(staged), true)
  assert.equal(statSync(staged).mode & 0o777, 0o600)

  const opJournalPath = join(stateDir, 'operations', `${opId}.json`)
  const opJournalText = readFileSync(opJournalPath, 'utf8')
  assert.equal(opJournalText.includes('slicer-test-pass'), false)
  assert.equal(opJournalText.includes('pkcs12_base64'), false)
  assert.equal(opJournalText.includes('client_certificate'), false)
  assert.equal(opJournalText.includes(certs.validKeyPem), false)

  const preparedReceiptSha256 =
    await import('../../packages/farm-protocol/src/configuration-receipt.ts').then(
      (m) => m.configurationReceiptHash(prepRes.receipt),
    )

  const commitRes = await engine.handle({
    frame: {
      v: 1,
      protocol: 'config-v1',
      type: 'commit',
      request_id: randomUUID(),
      operation_id: opId,
      expected_revision: 0,
      target_sha256: targetSha256,
      prepared_receipt_sha256: preparedReceiptSha256,
    },
    context: makeContext('commit'),
  })
  assert.equal(commitRes.type, 'result')
  assert.equal(commitRes.state, 'local-committed')

  const { configurationReceiptHash } =
    await import('../../packages/farm-protocol/src/configuration-receipt.ts')
  const localCommittedSha = await configurationReceiptHash(commitRes.receipt)
  const invRes = await engine.confirmInventory({
    ack: {
      operation_id: opId,
      local_committed_receipt_sha256: localCommittedSha,
      committed_revision: commitRes.receipt.committed_revision,
    },
    attestation: 'ack',
    context: makeContext('commit'),
  })
  assert.equal(invRes.ok, true)

  const identity = await deriveConfigurationAssignmentIdentity({
    account_id: 'account_1',
    farm_id: ids.farm,
    agent_id: ids.agent,
    bridge_instance_id: commitRes.receipt.target.bridge_instance_id,
    device_id: commitRes.receipt.target.device_id,
  })
  const finalCertPath = assignmentKobraCertPath(
    stateDir,
    identity.assignment_id,
  )
  const sharedCertPath = kobraClientCertPath(stateDir)
  assert.equal(existsSync(staged), false)
  assert.equal(existsSync(finalCertPath), true)
  assert.equal(existsSync(sharedCertPath), true)
  assert.equal(statSync(finalCertPath).mode & 0o777, 0o600)
  assert.equal(statSync(sharedCertPath).mode & 0o777, 0o600)

  const loadedMaterial = readKobraClientCertMaterial(finalCertPath)
  assert.equal(loadedMaterial.ok, true)
  assert.equal(loadedMaterial.cert.commonName, 'AnycubicSlicer')

  const runtime = readAgentRuntimeConfig(runtimePath, {
    agent_id: ids.agent,
    farm_id: ids.farm,
  })
  assert.equal(
    runtime.collection.kobralink.printers[0]?.clientCertFile,
    finalCertPath,
  )
  const runtimeRaw = readFileSync(runtimePath, 'utf8')
  assert.equal(runtimeRaw.includes('slicer-test-pass'), false)
  assert.equal(runtimeRaw.includes(certs.validKeyPem), false)
})

async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

test('Server PostgreSQL database and API responses never contain client private keys or cert material', async () => {
  const pgBase = join(workDir, 'pg-cluster')
  const dataDir = join(pgBase, 'data')
  const logFile = join(pgBase, 'postgres.log')
  mkdirSync(dataDir, { recursive: true })

  const port = await freePort()
  const pwFile = join(pgBase, 'pgpass')
  writeFileSync(pwFile, 'testpostgres\n', { mode: 0o600 })
  execFileSync('/opt/homebrew/bin/initdb', [
    '-D',
    dataDir,
    '-U',
    'postgres',
    '--auth=trust',
    `--pwfile=${pwFile}`,
    '--encoding=UTF8',
  ])
  execFileSync('/opt/homebrew/bin/pg_ctl', [
    '-D',
    dataDir,
    '-l',
    logFile,
    '-o',
    `-h 127.0.0.1 -p ${port} -c unix_socket_directories=`,
    'start',
  ])
  pgControl.dataDir = dataDir

  const admin = postgres({
    host: '127.0.0.1',
    port,
    database: 'postgres',
    user: 'postgres',
    max: 4,
  })
  const roleClients = []
  try {
    const catalog = await loadMigrationCatalog()
    await runMigrations(admin, catalog, { kind: 'up' })

    const role = 'cfg_' + randomUUID().replaceAll('-', '')
    await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_configuration_authority`
    const roleSql = postgres({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: role,
      max: 4,
    })
    roleClients.push(roleSql)

    const now = Date.now()
    const accountId = 'acc_' + randomUUID()
    const farmId = randomUUID()
    const keyId = randomUUID()
    const config = {
      origin: 'https://configuration.example',
      audience: 'farm',
      credentialIssuer: 'fixture',
      credentialAudience: 'connector',
      idleTimeoutMs: 1_800_000,
    }

    await admin`INSERT INTO farm.session_accounts(id) VALUES (${accountId})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${accountId},${accountId},0,${now},${now},${now + 1_800_000})`
    await admin`INSERT INTO farm.farms(id) VALUES (${farmId}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${farmId}::uuid,${accountId},'owner')`

    const connectorKeys = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])
    const connectorPrivNode = generateKeyPairSync('ed25519')
    const identity = new ConnectorIdentity(connectorPrivNode.privateKey)
    const connectorSigningKey = await crypto.subtle.importKey(
      'pkcs8',
      connectorPrivNode.privateKey.export({ format: 'der', type: 'pkcs8' }),
      { name: 'Ed25519' },
      false,
      ['sign'],
    )

    const pairing = new PostgresPairing(admin, {
      origin: config.origin,
      audience: 'open3dfarmmanager:pairing',
    })
    const proof = new PostgresPairingProof(admin, {
      origin: config.origin,
      audience: 'open3dfarmmanager:pairing',
    })
    const started = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    assert.ok(started.ok)
    const ch = await proof.issue({ device_code: started.response.device_code })
    assert.ok(ch.ok)
    const comp = await proof.complete({
      device_code: started.response.device_code,
      challenge: ch.challenge,
      signature: identity.signPairingProof({
        challenge: ch.challenge,
        expectedOrigin: config.origin,
        expectedAudience: 'open3dfarmmanager:pairing',
        now: Date.now(),
      }),
    })
    assert.ok(comp.ok)
    await pairing.decide({
      sessionRecordId: accountId,
      policy: { idleTimeoutMs: 1_800_000 },
      decision: 'approve',
      request: {
        user_code: started.response.user_code,
        farm_id: farmId,
        expected_fingerprint: identity.fingerprint,
      },
    })
    const issuerKeys = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const claimed = await pairing.claim(
      { device_code: started.response.device_code },
      {
        issuer: config.credentialIssuer,
        audience: config.credentialAudience,
        kid: 'fixture',
        privateKey: issuerKeys.privateKey,
        ttlSeconds: 3600,
      },
    )
    assert.ok(claimed.ok && claimed.status === 'approved')
    const agentId = claimed.agent_id

    const browser = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
    const browserKey = await validateBrowserDevicePublicKey({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    })
    await admin`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES (${keyId}::uuid,${farmId}::uuid,${accountId},${admin.json(browserKey.publicKey)}::jsonb,${browserKey.thumbprint},${now})`
    await admin`UPDATE farm.browser_device_keys SET status='approved',proof_at=${now},proof_session_id=${accountId},approved_at=${now},approved_by=${accountId} WHERE key_id=${keyId}::uuid`

    // Provision locally on Connector with real Kobra client cert + register in PG service
    const provDir = join(workDir, 'pg-prov')
    const runtimePath = join(provDir, 'runtime.json')
    mkdirSync(provDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      runtimePath,
      JSON.stringify({
        version: 1,
        collection: { version: 1, allowedOrigins: [], printers: [] },
        assignments: [],
        telemetry: {
          endpoint: 'https://farm.example/telemetry',
          audience: 'test',
        },
      }),
      { mode: 0o600 },
    )
    const bridge = syntheticBridge({ '192.168.1.55': 'kx-pg-0001' })
    const engine = createProvisioningEngine({
      stateDirectory: join(provDir, 'state'),
      runtime: {
        runtimeConfigPath: runtimePath,
        agent_id: agentId,
        farm_id: farmId,
      },
      connector: {
        fingerprint: identity.fingerprint,
        receiptKey: connectorSigningKey,
      },
      authority: trustProvisioningAuthority({
        async isCurrent() {
          return true
        },
        async acceptsInventoryAck() {
          return true
        },
      }),
      managedBridge: {
        origin: 'http://127.0.0.1:7100',
        ownership: 'connector-owned-fresh',
      },
      printerNetworks: ['192.168.1.0/24'],
      fetch: bridge.fetch,
    })

    const targetWithCert = {
      v: 1,
      protocol: 'config-v1',
      backend: 'kobralink-anycubic',
      model: { family: 'anycubic-kobra-x', provisional: true },
      endpoint: { ipv4: '192.168.1.55', port: 18910 },
      bridge: { kind: 'connector-managed' },
      client_certificate: {
        kind: 'inline',
        format: 'pem',
        certificate_pem: certs.validCertPem,
        key_pem: certs.validKeyPem,
      },
    }
    const targetSha256 = await configurationTargetHash(targetWithCert)
    const opId = randomUUID()
    const [{ jti: credJti }] =
      await admin`SELECT jti FROM farm.connector_credentials WHERE agent_id=${agentId}::uuid`
    const transportId = randomUUID()
    let pgNonce = 10
    const makeCtx = (action) => ({
      account_id: accountId,
      role: 'owner',
      farm_id: farmId,
      agent_id: agentId,
      key_id: keyId,
      credential_jti: credJti,
      transport_id: transportId,
      connector_fingerprint: identity.fingerprint,
      capability_id: randomUUID(),
      admission_nonce: base64url(new Uint8Array(32).fill(++pgNonce % 250)),
      action,
    })

    const prepRes = await engine.handle({
      frame: {
        v: 1,
        protocol: 'config-v1',
        type: 'prepare',
        request_id: randomUUID(),
        operation_id: opId,
        expected_revision: 0,
        target: targetWithCert,
      },
      context: makeCtx('prepare'),
    })
    assert.equal(prepRes.type, 'result')

    const { configurationReceiptHash, encodeConfigurationReceipt } =
      await import('../../packages/farm-protocol/src/configuration-receipt.ts')
    const prepSha = await configurationReceiptHash(prepRes.receipt)
    const commitRes = await engine.handle({
      frame: {
        v: 1,
        protocol: 'config-v1',
        type: 'commit',
        request_id: randomUUID(),
        operation_id: opId,
        expected_revision: 0,
        target_sha256: targetSha256,
        prepared_receipt_sha256: prepSha,
      },
      context: makeCtx('commit'),
    })
    assert.equal(commitRes.type, 'result', JSON.stringify(commitRes))
    assert.equal(commitRes.state, 'local-committed')

    const store = new PostgresConfigurationStore(roleSql, config)
    const bindingHash = base64url(new Uint8Array(32).fill(9))
    const regService = createConfigurationRegistrationService({
      store,
      registry: {
        advertised() {
          return { jti: credJti, revision: 0 }
        },
        activeContext() {
          return {
            expiresAt: Date.now() + 60_000,
            transportId,
            bindingSha256: bindingHash,
          }
        },
      },
      issuer: {
        issuer: config.origin,
        kid: 'cfg-kid',
        privateKey: issuerKeys.privateKey,
      },
    })

    await store.transaction(
      { sessionRecordId: accountId, farmId, agentId, keyId },
      async (tx) => {
        await tx.createOperation({
          operation_id: opId,
          account_id: accountId,
          farm_id: farmId,
          agent_id: agentId,
          key_id: keyId,
          expected_revision: 0,
          target_sha256: targetSha256,
          commit_sha256: prepSha,
          created_at: Date.now(),
        })
      },
    )

    const regResult = await regService.register({
      sessionRecordId: accountId,
      farmId,
      request: {
        keyId,
        receiptWire: encodeConfigurationReceipt(commitRes.receipt),
      },
    })
    assert.equal(regResult.ok, true, JSON.stringify(regResult))

    const apiJson = JSON.stringify(regResult)
    assert.equal(apiJson.includes(certs.validKeyPem), false)
    assert.equal(apiJson.includes(certs.validCertPem), false)
    assert.equal(apiJson.includes('client_certificate'), false)

    const opRows = await admin`SELECT * FROM farm.configuration_operations`
    const recRows = await admin`SELECT * FROM farm.configuration_receipts`
    const assignRows = await admin`SELECT * FROM farm.printer_assignments`
    const dbDump = JSON.stringify({ opRows, recRows, assignRows })
    assert.equal(assignRows.length, 1)
    assert.equal(dbDump.includes(certs.validKeyPem), false)
    assert.equal(dbDump.includes(certs.validCertPem), false)
    assert.equal(dbDump.includes('client_certificate'), false)
    assert.equal(dbDump.includes('key_pem'), false)
  } finally {
    await Promise.all(
      roleClients.map((client) => client.end({ timeout: 3 }).catch(() => {})),
    )
    await admin.end({ timeout: 3 }).catch(() => {})
  }
})

test('Printer status renders "client certificate missing" when Connector reports missing client certificate', async () => {
  const dir = join(workDir, 'collect-missing-cert')
  mkdirSync(dir, { recursive: true })
  const credFile = join(dir, 'cred.json')
  writeFileSync(
    credFile,
    JSON.stringify({
      version: 1,
      bridgeInstance: 'b1',
      origin: 'http://127.0.0.1:7100',
      deviceId: 'kx-missing',
      id: 'p1',
      printerKey: 'kobra-x-missing-cert-printer',
      revision: 1,
      name: 'Kobra X Missing',
      email: 'connector@example.invalid',
      password: 'password123',
    }),
    { mode: 0o600 },
  )
  const queueDir = join(dir, 'queue')
  const queue = new TelemetryQueue(queueDir, Date.now())
  const ac = new AbortController()
  const rawStates = []
  try {
    await collectIntoQueue({
      config: {
        version: 2,
        allowedOrigins: [],
        printers: [],
        kobralink: {
          allowedOrigins: ['http://127.0.0.1:7100'],
          printers: [
            {
              backend: 'kobralink',
              version: 2,
              bridgeInstance: 'b1',
              origin: 'http://127.0.0.1:7100',
              deviceId: 'kx-missing',
              id: 'p1',
              printerKey: 'kobra-x-missing-cert-printer',
              revision: 1,
              credentialFile: credFile,
              clientCertFile: join(dir, 'nonexistent-cert.json'),
            },
          ],
        },
      },
      queue,
      signal: ac.signal,
      kobraFetch: async () =>
        new Response(
          JSON.stringify([
            {
              id: 'p1',
              deviceId: 'kx-missing',
              ip: '192.168.1.50',
              name: 'Kobra X Missing',
              model: 'Kobra X',
              live: null,
              connectionError: {
                code: 'client_certificate_missing',
                message: 'client certificate missing',
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      onRawObservation(obs) {
        rawStates.push(obs.printer)
        ac.abort()
      },
      onDiagnostic() {},
    })
  } finally {
    queue.close()
  }

  assert.ok(rawStates.length >= 1)
  const parsed = PrinterState.parse(rawStates[0])
  assert.equal(parsed.state, 'offline')
  assert.equal(parsed.statusReason, 'client-certificate-missing')
  assert.match(formatPrinterStateLabel(parsed), /client certificate missing/i)
})

test('No real or hardcoded PEM headers are committed in packages or apps', () => {
  try {
    const result = execFileSync(
      'rg',
      ['-n', 'BEGIN (CERTIFICATE|PRIVATE KEY)', 'packages', 'apps'],
      { encoding: 'utf8' },
    )
    assert.fail(`Unexpected PEM literals found:\n${result}`)
  } catch (err) {
    assert.equal(
      err.status,
      1,
      `Expected zero PEM matches (rg exit 1), got status=${err.status}: ${err.stderr ?? err.message}`,
    )
  }
})
