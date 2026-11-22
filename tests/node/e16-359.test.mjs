// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CAMERA_CHANNEL_LABEL,
  ConnectorCameraMedia,
} from '../../packages/connector/src/camera/camera-media.ts'
import {
  checkRtspCameraStatus,
  getRtspCameraStatus,
} from '../../packages/connector/src/camera/camera-runtime.ts'
import { parseCameraRuntimeConfig } from '../../packages/connector/src/config/camera.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  decodeCameraPurposeProof,
  signCameraPurposeProof,
} from '../../packages/farm-protocol/src/camera-purpose-statement.ts'
import { RtcSessionBinding } from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import { verifyRtsp } from '../../packages/sim-tools/src/rtsp.ts'
import {
  buildRtspIngest,
  compareGoVersions,
  parseGoModMinVersion,
  parseGoVersionOutput,
  RTSP_INGEST_DIR,
  RTSP_INGEST_GO_MOD,
} from '../../scripts/build-rtsp-ingest.mjs'
import {
  checkRtspHelperStatus,
  getRtspHelperStatusSync,
  openHelperSource,
  startRtspCameraMock,
} from '../../tools/rtsp-ingest/supervisor/process.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VENDOR_SOURCES_DIR = join(REPO_ROOT, 'third_party/rtsp-ingest/sources')

function stripGoFromPath(pathValue = process.env.PATH ?? '') {
  return pathValue
    .split(delimiter)
    .filter((dir) => {
      if (!dir) return false
      return !existsSync(join(dir, 'go')) && !existsSync(join(dir, 'go.exe'))
    })
    .join(delimiter)
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('go.mod declares the minimum Go version allowed by vendored modules (1.26.0) and vendor verification passes', () => {
  const declaredMin = parseGoModMinVersion(RTSP_INGEST_GO_MOD)
  assert.equal(declaredMin, '1.26.0')

  const vendorDirs = readdirSync(VENDOR_SOURCES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert.ok(vendorDirs.length > 0, 'expected vendored module directories')

  let highestVendored = '1.0.0'
  for (const dirName of vendorDirs) {
    const modFile = join(VENDOR_SOURCES_DIR, dirName, 'go.mod')
    if (!existsSync(modFile)) continue
    const content = readFileSync(modFile, 'utf8')
    const match = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(content)
    if (!match) continue
    const version =
      match[1].split('.').length === 2 ? `${match[1]}.0` : match[1]
    if (compareGoVersions(version, highestVendored) > 0) {
      highestVendored = version
    }
  }
  assert.equal(
    highestVendored,
    declaredMin,
    'tools/rtsp-ingest/go.mod must match the lowest version allowed by vendored modules',
  )

  const verifyResult = spawnSync(
    'python3',
    ['third_party/rtsp-ingest/verify.py'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  )
  assert.equal(
    verifyResult.status,
    0,
    `verify.py failed: ${verifyResult.stderr || verifyResult.stdout}`,
  )
  assert.match(verifyResult.stdout, /PASS:/)
})

test('offline build:rtsp-ingest and go test ./... pass with network blocked and empty GOMODCACHE', (t) => {
  const tempRoot = makeTempDir('e16-359-offline-go-')
  const emptyModCache = join(tempRoot, 'gomodcache')
  const binDir = join(tempRoot, 'bin')
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const offlineEnv = {
    ...process.env,
    GOPROXY: 'off',
    RTSP_INGEST_BIN_DIR: binDir,
    GOTOOLCHAIN: 'local',
    GOFLAGS: '-mod=readonly',
    GOWORK: 'off',
    GOMODCACHE: emptyModCache,
    npm_config_verify_deps_before_run: 'false',
  }

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const hasNpmScript = Boolean(pkg?.scripts?.['build:rtsp-ingest'])
  const npmBuild = hasNpmScript
    ? spawnSync('npm', ['run', 'build:rtsp-ingest'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: offlineEnv,
      })
    : spawnSync(process.execPath, ['scripts/build-rtsp-ingest.mjs'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: offlineEnv,
      })
  assert.equal(
    npmBuild.status,
    0,
    `build-rtsp-ingest failed: ${npmBuild.stderr || npmBuild.stdout}`,
  )
  assert.match(npmBuild.stdout, /rtsp-ingest built offline with go/)

  const helperBin = join(binDir, 'rtsp-ingest')
  const fixtureBin = join(binDir, 'rtspfixture')
  assert.ok(existsSync(helperBin), 'expected tools/rtsp-ingest/bin/rtsp-ingest')
  assert.ok(
    existsSync(fixtureBin),
    'expected tools/rtsp-ingest/bin/rtspfixture',
  )
  assert.ok((statSync(helperBin).mode & 0o111) !== 0)
  assert.ok((statSync(fixtureBin).mode & 0o111) !== 0)

  // Verify helper status reports available when built
  const helperStatus = getRtspHelperStatusSync({ path: helperBin })
  assert.equal(helperStatus.available, true)
  assert.equal(helperStatus.status, 'available')
  assert.match(helperStatus.sha256 ?? '', /^[a-f0-9]{64}$/)

  // Verify Linux amd64 cross-build also succeeds offline with empty GOMODCACHE
  const linuxOut = join(tempRoot, 'linux-amd64-bin')
  const linuxBuild = buildRtspIngest({
    binDir: linuxOut,
    env: {
      ...offlineEnv,
      GOOS: 'linux',
      GOARCH: 'amd64',
      CGO_ENABLED: '0',
    },
    log: () => {},
  })
  assert.equal(linuxBuild.built, true)
  assert.ok(existsSync(join(linuxOut, 'rtsp-ingest')))

  // Verify empty GOMODCACHE remained unpopulated by network downloads
  if (existsSync(emptyModCache)) {
    assert.deepEqual(readdirSync(emptyModCache), [])
  }

  // Run offline go test ./...
  const goTest = spawnSync('go', ['test', './...'], {
    cwd: RTSP_INGEST_DIR,
    encoding: 'utf8',
    env: offlineEnv,
  })
  assert.equal(
    goTest.status,
    0,
    `offline go test ./... failed: ${goTest.stderr || goTest.stdout}`,
  )
  assert.match(
    goTest.stdout,
    /open3dfarm\.local\/rtsp-ingest\/cmd\/rtspfixture/,
  )
  assert.match(
    goTest.stdout,
    /open3dfarm\.local\/rtsp-ingest\/internal\/aupipe/,
  )
  assert.match(
    goTest.stdout,
    /open3dfarm\.local\/rtsp-ingest\/internal\/ingest/,
  )
  assert.match(
    goTest.stdout,
    /open3dfarm\.local\/rtsp-ingest\/internal\/rtspfixture/,
  )
})

test('build:rtsp-ingest reports clearly and exits 0 when Go is missing or older than minimum 1.26.0', (t) => {
  const tempRoot = makeTempDir('e16-359-no-go-')
  const fakeBinDir = join(tempRoot, 'fake-bin')
  const outDir = join(tempRoot, 'out-bin')
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  // 1. Go missing from PATH
  const noGoPath = stripGoFromPath(process.env.PATH ?? '')
  const missingResult = spawnSync(
    process.execPath,
    ['scripts/build-rtsp-ingest.mjs'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: noGoPath,
        RTSP_INGEST_BIN_DIR: outDir,
      },
    },
  )
  assert.equal(missingResult.status, 0)
  assert.match(
    missingResult.stdout,
    /rtsp-ingest build skipped: go is not available on PATH \(requires go >= 1\.26\.0\); RTSP ingest helper is unavailable\./,
  )
  assert.equal(existsSync(join(outDir, 'rtsp-ingest')), false)

  // 2. Go older than minimum (e.g. go1.25.4)
  rmSync(fakeBinDir, { recursive: true, force: true })
  mkdirSyncCompat(fakeBinDir)
  const fakeOldGo = join(fakeBinDir, 'go')
  writeFileSync(
    fakeOldGo,
    '#!/bin/sh\necho "go version go1.25.4 darwin/arm64"\n',
    { mode: 0o755 },
  )
  chmodSync(fakeOldGo, 0o755)

  const oldResult = spawnSync(
    process.execPath,
    ['scripts/build-rtsp-ingest.mjs'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${delimiter}${noGoPath}`,
        RTSP_INGEST_BIN_DIR: outDir,
      },
    },
  )
  assert.equal(oldResult.status, 0)
  assert.match(
    oldResult.stdout,
    /rtsp-ingest build skipped: found go 1\.25\.4, requires go >= 1\.26\.0; RTSP ingest helper is unavailable\./,
  )
  assert.equal(existsSync(join(outDir, 'rtsp-ingest')), false)

  assert.deepEqual(parseGoVersionOutput('go version go1.26.0 linux/amd64'), {
    version: '1.26.0',
    tuple: [1, 26, 0],
  })
})

function mkdirSyncCompat(dir) {
  spawnSync(process.execPath, [
    '-e',
    'require("node:fs").mkdirSync(process.argv[1], { recursive: true })',
    dir,
  ])
}

test('when Go helper is unavailable, Connector reports RTSP cameras unavailable with clear status while non-RTSP cameras, RTC status, and Node RTSP mock fallback work', async (t) => {
  const tempRoot = makeTempDir('e16-359-camera-fallback-')
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const missingHelperPath = join(tempRoot, 'missing-rtsp-ingest')
  const helperStatus = await checkRtspHelperStatus({
    path: missingHelperPath,
    sha256: 'a'.repeat(64),
  })
  assert.equal(helperStatus.available, false)
  assert.equal(helperStatus.helperAvailable, false)
  assert.equal(helperStatus.status, 'unavailable')
  assert.equal(helperStatus.reason, 'helper-unavailable')
  assert.match(helperStatus.message, /helper is unavailable/i)

  const rtspAssignmentId = randomUUID()
  const snapshotAssignmentId = randomUUID()
  const runtimeConfig = parseCameraRuntimeConfig(
    {
      helper: {
        path: missingHelperPath,
        sha256: 'a'.repeat(64),
      },
      maxSessions: 2,
      cameras: [
        {
          cameraId: 'rtsp-cam-1',
          assignmentId: rtspAssignmentId,
          source: {
            address: '127.0.0.1',
            port: 8554,
            path: '/test',
          },
        },
        {
          cameraId: 'moonraker-cam-1',
          assignmentId: snapshotAssignmentId,
          source: {
            kind: 'moonraker-snapshot',
            address: '127.0.0.1',
            port: 7125,
            path: '/webcam/?action=snapshot',
            ffmpeg: {
              path: '/usr/bin/ffmpeg',
              sha256: 'b'.repeat(64),
            },
          },
        },
      ],
    },
    [rtspAssignmentId, snapshotAssignmentId],
  )

  const cameraStatus = await checkRtspCameraStatus(runtimeConfig)
  assert.equal(cameraStatus.available, false)
  assert.equal(cameraStatus.status, 'unavailable')
  assert.equal(cameraStatus.reason, 'helper-unavailable')
  assert.match(cameraStatus.message, /helper is unavailable/i)
  assert.deepEqual(cameraStatus, getRtspCameraStatus(runtimeConfig))

  const rtspEntry = cameraStatus.cameras.find(
    (entry) => entry.cameraId === 'rtsp-cam-1',
  )
  const snapshotEntry = cameraStatus.cameras.find(
    (entry) => entry.cameraId === 'moonraker-cam-1',
  )
  assert.ok(rtspEntry)
  assert.equal(rtspEntry.available, false)
  assert.equal(rtspEntry.status, 'unavailable')
  assert.equal(rtspEntry.reason, 'helper-unavailable')
  assert.match(rtspEntry.message, /helper is unavailable/i)

  assert.ok(snapshotEntry)
  assert.equal(snapshotEntry.available, true)
  assert.equal(snapshotEntry.status, 'available')

  // Verify ConnectorCameraMedia session with unavailable RTSP helper fails closed on media
  // with clear helper-unavailable status while causing zero peer violations
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const browserKeys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browserKeys.publicKey,
  )
  const browser = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const agentId = randomUUID()
  const farmId = randomUUID()
  const digest = () => randomBytes(32).toString('base64url')
  const now = Date.now()
  const binding = RtcSessionBinding.parse({
    v: 2,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: farmId,
    agent_id: agentId,
    account_id: 'e16_359_account',
    key_id: randomUUID(),
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now - 1000,
    expires_at: now + 20000,
    commands_enabled: false,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
    assignment_count: 1,
    assignment_digest: digest(),
  })

  let trackOpen = true
  const channelSent = []
  let messageHandler = () => {}
  const violations = []
  const nativeStub = {
    Video: class {
      addH264Codec() {}
      addSSRC() {}
    },
    RtpPacketizationConfig: class {
      timestamp = 0
    },
    H264RtpPacketizer: class {},
  }

  const media = new ConnectorCameraMedia({
    native: nativeStub,
    expectedAgentId: agentId,
    assignmentRefs: [
      {
        assignmentId: rtspAssignmentId,
        agentId,
        printerKey: 'printer-rtsp-1',
      },
    ],
    cameras: [
      {
        cameraId: 'rtsp-cam-1',
        scope: { farmId, agentId, printerId: rtspAssignmentId },
        sourceHandle: 'camera-0',
      },
    ],
    signProof: (statement) =>
      identity.signCameraPurposeProof({ statement, expectedAgentId: agentId }),
    openSource: (handle, signal, expiresAtMonoMs, isCurrent) =>
      openHelperSource({
        executable: { path: missingHelperPath, sha256: 'a'.repeat(64) },
        sourceHandle: handle,
        resolveLocal: () => ({
          address: '127.0.0.1',
          port: 8554,
          path: '/test',
        }),
        signal,
        expiresAtMonoMs,
        generation: 1,
        isAdmitted: () => !signal.aborted && isCurrent(),
      }),
    acquireSlot: () => () => {},
    onViolation: (reason) => violations.push(reason),
  })

  media.prepare({
    addVideoTrack() {
      return {
        setMediaHandler() {},
        onClosed() {},
        onError() {},
        isOpen: () => trackOpen,
        sendMessageBinary: () => trackOpen,
        close() {
          trackOpen = false
        },
      }
    },
    createDataChannel(label) {
      assert.equal(label, CAMERA_CHANNEL_LABEL)
      return {
        onMessage(fn) {
          messageHandler = fn
        },
        onClosed() {},
        sendMessage(wire) {
          channelSent.push(wire)
          return true
        },
        close() {},
      }
    },
  })

  media.activate({
    binding,
    lifetimeDeadline: performance.now() + 20000,
  })

  for (let i = 0; i < 100 && channelSent.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(channelSent.length, 1)
  const offered = decodeCameraPurposeProof(channelSent[0]).binding
  const browserProof = await signCameraPurposeProof(
    offered,
    'browser',
    browserKeys.privateKey,
  )
  messageHandler(browserProof)

  for (let i = 0; i < 100 && media.snapshot().state !== 'terminal'; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }

  const snap = media.snapshot()
  assert.equal(snap.state, 'terminal')
  assert.equal(snap.trackOpen, false)
  assert.equal(snap.sent, 0)
  assert.equal(snap.status, 'unavailable')
  assert.equal(snap.reason, 'helper-unavailable')
  assert.match(snap.message ?? '', /helper is unavailable/i)
  assert.equal(media.getStatus().status, 'unavailable')
  assert.equal(media.getStatus().reason, 'helper-unavailable')
  assert.deepEqual(
    violations,
    [],
    'missing helper must not trigger a peer protocol violation',
  )

  // Verify RTSP camera mock uses its Node fallback when Go helper is unavailable
  const mock = await startRtspCameraMock({
    helperExecutable: { path: missingHelperPath, sha256: 'a'.repeat(64) },
    path: '/test',
    packetsPerPlay: 8,
  })
  t.after(async () => {
    await mock.close()
  })
  assert.equal(mock.backend, 'node-fallback')
  assert.equal(mock.helperStatus.status, 'unavailable')
  assert.equal(mock.helperStatus.reason, 'helper-unavailable')
  const packets = await verifyRtsp(mock.url, { minPackets: 5, timeoutMs: 3000 })
  assert.ok(packets >= 5)
  await mock.close()
})

test('with go removed from PATH, scoped camera and supervisor checks pass', () => {
  const noGoPath = stripGoFromPath(process.env.PATH ?? '')
  const checkGo = spawnSync('go', ['version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: noGoPath },
  })
  assert.notEqual(
    checkGo.status,
    0,
    'expected go to be absent from stripped PATH',
  )

  const scopedTests = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      'tools/rtsp-ingest/supervisor/process.test.ts',
      'tools/rtsp-ingest/supervisor/record-reader.test.ts',
      'tools/rtsp-ingest/integration/moving-fixture-input.test.ts',
      'tests/node/camera-media.test.ts',
      'tests/node/camera-runtime-config.test.ts',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: noGoPath,
      },
    },
  )
  assert.equal(
    scopedTests.status,
    0,
    `scoped tests without go on PATH failed: ${scopedTests.stderr || scopedTests.stdout}`,
  )
})
