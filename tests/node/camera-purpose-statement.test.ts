// Original work, MIT licensed. Synthetic keys only; no product identity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, sign } from 'node:crypto'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import {
  RtcSessionBinding,
  decodeRtcProof,
  rtcSessionProofPayload,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import {
  CameraPurposeStatement,
  cameraPurposeProofPayload,
  encodeCameraPurposeProof,
  decodeCameraPurposeProof,
  verifyExpectedCameraPurposeProof,
  MAX_CAMERA_PROOF_WIRE_BYTES,
} from '../../packages/farm-protocol/src/camera-purpose-statement.ts'

const statement = {
  v: 3,
  purpose: 'camera-rtc',
  camera_id: 'camera-1',
  printer_id: '11111111-1111-4111-8111-111111111111',
  video_mid: '0',
  lease_ref: 'lease-1',
  assignment_count: 1,
  assignment_digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  transport_id: '11111111-1111-4111-8111-111111111111',
  farm_id: '11111111-1111-4111-8111-111111111111',
  agent_id: '11111111-1111-4111-8111-111111111111',
  account_id: 'synthetic',
  key_id: '11111111-1111-4111-8111-111111111111',
  browser_public_key: {
    kty: 'EC',
    crv: 'P-256',
    x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
    y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
  },
  browser_thumbprint: 'xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M',
  connector_public_key_spki:
    'MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  connector_fingerprint: 'SHA256:BuP9j9opu2CrWVV95h7bCuzbIxE0vjDnW0Vfjht5L6k',
  credential_jti: '11111111-1111-4111-8111-111111111111',
  origin: 'https://farm.example',
  audience: 'open3dfarmmanager:connector',
  browser_nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  connector_nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  issued_at: 1000,
  expires_at: 31000,
  commands_enabled: false,
  offer_sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  answer_sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  browser_dtls:
    'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA',
  connector_dtls:
    'BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB',
}
// Literal bytes are independent of the codec under test.
const literal =
  '{"account_id":"synthetic","agent_id":"11111111-1111-4111-8111-111111111111","answer_sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","assignment_count":1,"assignment_digest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","audience":"open3dfarmmanager:connector","browser_dtls":"AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA","browser_nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","browser_public_key":{"crv":"P-256","kty":"EC","x":"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY","y":"T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"},"browser_thumbprint":"xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M","camera_id":"camera-1","commands_enabled":false,"connector_dtls":"BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB","connector_fingerprint":"SHA256:BuP9j9opu2CrWVV95h7bCuzbIxE0vjDnW0Vfjht5L6k","connector_nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","connector_public_key_spki":"MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","credential_jti":"11111111-1111-4111-8111-111111111111","expires_at":31000,"farm_id":"11111111-1111-4111-8111-111111111111","issued_at":1000,"key_id":"11111111-1111-4111-8111-111111111111","lease_ref":"lease-1","offer_sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","origin":"https://farm.example","printer_id":"11111111-1111-4111-8111-111111111111","purpose":"camera-rtc","transport_id":"11111111-1111-4111-8111-111111111111","v":3,"video_mid":"0"}'
const browserKey = createPrivateKey({
  format: 'jwk',
  key: {
    ...statement.browser_public_key,
    d: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
  },
})
const connectorKey = createPrivateKey({
  format: 'der',
  type: 'pkcs8',
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  ),
})
function fixture(role: 'browser' | 'connector') {
  const payload = Buffer.from(
    'Open3DFarmManager/camera-purpose-proof/v1\0' + role + '\0' + literal,
  )
  const signature =
    role === 'browser'
      ? sign('sha256', payload, {
          key: browserKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url')
      : sign(null, payload, connectorKey).toString('base64url')
  const proof = { v: 3, role, binding: statement, signature }
  const input = {
    expectedStatement: statement,
    expectedRole: role,
    expectedPublicKey:
      role === 'browser'
        ? statement.browser_public_key
        : statement.connector_public_key_spki,
    wire: canonicalize(proof),
  }
  return { proof, input, payload }
}
test('literal V3 signed statement verifies with both maintained role algorithms', async () => {
  assert.equal(canonicalize(statement), literal)
  for (const role of ['browser', 'connector'] as const) {
    const { proof, input, payload } = fixture(role)
    assert.deepEqual(
      Buffer.from(cameraPurposeProofPayload(statement, role)),
      payload,
    )
    assert.equal(encodeCameraPurposeProof(proof), input.wire)
    assert.deepEqual(decodeCameraPurposeProof(input.wire), proof)
    assert.deepEqual(await verifyExpectedCameraPurposeProof(input), proof)
    assert.throws(() => RtcSessionBinding.parse(statement))
    assert.throws(() => decodeRtcProof(input.wire))
    assert.throws(() => rtcSessionProofPayload(statement, role))
  }
})
test('every added field and transcript/session mutation rejects against expected and signature', async () => {
  const patches = [
    { camera_id: 'camera-2' },
    { printer_id: '22222222-2222-4222-8222-222222222222' },
    { video_mid: '1' },
    { lease_ref: 'lease-2' },
    { assignment_count: 2 },
    { assignment_digest: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
    { transport_id: '22222222-2222-4222-8222-222222222222' },
    { offer_sha256: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
    { answer_sha256: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
    { browser_nonce: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
    { connector_nonce: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
    { browser_dtls: statement.connector_dtls },
    { farm_id: '22222222-2222-4222-8222-222222222222' },
    { agent_id: '22222222-2222-4222-8222-222222222222' },
    { key_id: '22222222-2222-4222-8222-222222222222' },
    { credential_jti: '22222222-2222-4222-8222-222222222222' },
    { account_id: 'other' },
    { origin: 'https://other.example' },
    { issued_at: 1001 },
    { expires_at: 30999 },
    { browser_thumbprint: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
    {
      connector_fingerprint:
        'SHA256:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    },
    { connector_dtls: statement.browser_dtls },
    { commands_enabled: true },
    { purpose: 'read-only-rtc' },
    { v: 2 },
  ]
  for (const role of ['browser', 'connector'] as const) {
    const { proof, input } = fixture(role)
    for (const patch of patches) {
      const changed = { ...statement, ...patch }
      const wire = canonicalize({ ...proof, binding: changed })
      assert.equal(
        await verifyExpectedCameraPurposeProof({ ...input, wire }),
        null,
      )
      assert.equal(
        await verifyExpectedCameraPurposeProof({
          ...input,
          expectedStatement: changed,
          wire,
        }),
        null,
      )
      assert.equal(
        await verifyExpectedCameraPurposeProof({
          ...input,
          expectedStatement: changed,
        }),
        null,
      )
    }
    assert.equal(
      await verifyExpectedCameraPurposeProof({
        ...input,
        expectedRole: role === 'browser' ? 'connector' : 'browser',
      }),
      null,
    )
    assert.equal(
      await verifyExpectedCameraPurposeProof({
        ...input,
        expectedPublicKey:
          role === 'browser'
            ? {
                ...statement.browser_public_key,
                x: statement.browser_public_key.y,
              }
            : statement.browser_public_key,
      }),
      null,
    )
    assert.equal(
      await verifyExpectedCameraPurposeProof({
        ...input,
        wire: canonicalize({
          ...proof,
          role: role === 'browser' ? 'connector' : 'browser',
        }),
      }),
      null,
    )
  }
})
test('strict bounded canonical frames reject unknown/private handles and malformed values', async () => {
  const { proof, input } = fixture('browser')
  for (const field of [
    'sourceHandle',
    'source_handle',
    'url',
    'private_key',
    'unknown',
  ]) {
    const binding = { ...statement, [field]: 'private' }
    assert.throws(() => CameraPurposeStatement.parse(binding))
    assert.equal(
      await verifyExpectedCameraPurposeProof({
        ...input,
        wire: canonicalize({ ...proof, binding }),
      }),
      null,
    )
    assert.throws(() =>
      decodeCameraPurposeProof(canonicalize({ ...proof, [field]: 'private' })),
    )
  }
  for (const patch of [
    { camera_id: '' },
    { lease_ref: 'x'.repeat(129) },
    { video_mid: 'x'.repeat(65) },
    { printer_id: 'private printer' },
    { expires_at: 31001 },
    { browser_public_key: { ...statement.browser_public_key, d: 'private' } },
  ])
    assert.throws(() =>
      CameraPurposeStatement.parse({ ...statement, ...patch }),
    )
  for (const wire of [
    ' ' + input.wire,
    JSON.stringify(proof, null, 2),
    input.wire.replace('"v":3', '"v":3,"v":3'),
    input.wire.replace('camera-1', 'camera-\\u0031'),
    'x'.repeat(MAX_CAMERA_PROOF_WIRE_BYTES + 1),
    '{"x":' + '['.repeat(8) + '0' + ']'.repeat(8) + '}',
    input.wire.replace('camera-1', 'é'.repeat(5000)),
  ]) {
    assert.throws(() => decodeCameraPurposeProof(wire))
    assert.equal(
      await verifyExpectedCameraPurposeProof({ ...input, wire }),
      null,
    )
  }
})
