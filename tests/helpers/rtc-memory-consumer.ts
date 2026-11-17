// SPDX-License-Identifier: MIT
// Native browser-role endpoint in its own process: SIGSTOP suspends SCTP reads,
// unlike delaying a JavaScript onMessage callback in an otherwise running browser.
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { native, Command, type Role, until } from './rtc-memory-wire.ts'
import type { DataChannel } from '../../packages/connector/node_modules/node-datachannel'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { ReadonlyRtcSession } from '../../packages/connector/src/webrtc/readonly-session.ts'
import { PauseControlSession } from '../../packages/connector/src/webrtc/pause-control-session.ts'
import {
  rtcBindingFromDescriptions,
  rtcDtlsFingerprint,
  signRtcSessionProof,
  decodeRtcProof,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import { controlBindingFromDescriptions } from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  decodeCameraPurposeProof,
  verifyExpectedCameraPurposeProof,
  signCameraPurposeProof,
} from '../../packages/farm-protocol/src/camera-purpose-statement.ts'

if (process.env.OPENFARM_RTC_MEMORY !== '1')
  throw Error('RTC memory opt-in required')
native.setSctpSettings({ recvBufferSize: 65536 })
const keys = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
)
const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', keys.publicKey)
const browser = await validateBrowserDevicePublicKey({ kty, crv, x, y })
type Endpoint = {
  peer: InstanceType<typeof native.PeerConnection>
  channels: Map<string, DataChannel>
  readonly?: ReadonlyRtcSession
  control?: PauseControlSession
  ready: boolean
  offer: string
  answer: string
}
const endpoints = new Map<Role, Endpoint>()
let statuses = 0,
  cameraPackets = 0,
  cameraBytes = 0
let failure: Error | undefined
const fail = (error: unknown) => {
  failure = error instanceof Error ? error : Error(String(error))
}
function reset() {
  for (const endpoint of endpoints.values()) {
    endpoint.readonly?.close()
    endpoint.control?.close()
    endpoint.peer.close()
  }
  endpoints.clear()
}
async function command(input: unknown) {
  const cmd = Command.parse(input)
  if (failure) throw failure
  switch (cmd.kind) {
    case 'hello':
      return { kind: 'hello', ...browser, pid: process.pid }
    case 'offer': {
      assert.ok(!endpoints.has(cmd.role))
      const peer = new native.PeerConnection('memory-consumer-' + cmd.role, {
        iceServers: [],
        bindAddress: '127.0.0.1',
        enableIceTcp: false,
        maxMessageSize: 8192,
      })
      const endpoint: Endpoint = {
        peer,
        channels: new Map(),
        ready: false,
        offer: cmd.sdp,
        answer: '',
      }
      endpoints.set(cmd.role, endpoint)
      peer.onTrack((track) => {
        track.onMessage((packet) => {
          cameraPackets++
          cameraBytes += packet.byteLength
        })
      })
      peer.onDataChannel((channel) => {
        endpoint.channels.set(channel.getLabel(), channel)
        channel.onMessage((raw) => {
          if (channel.getLabel() === 'readonly-proof-v1') {
            if (!endpoint.readonly) return fail(Error('Proof before binding'))
            void endpoint.readonly.inspectProof(decodeRtcProof(raw)).catch(fail)
          } else if (channel.getLabel() === 'readonly-fixture-status-v1') {
            endpoint.readonly?.receiveApplication(raw)
            statuses++
          } else if (channel.getLabel() === 'pause-control-v1') {
            endpoint.control?.receive(raw)
          } else if (channel.getLabel() === 'camera-purpose-v3') {
            void (async () => {
              const proof = decodeCameraPurposeProof(raw)
              assert.equal(proof.role, 'connector')
              await verifyExpectedCameraPurposeProof({
                wire: raw,
                expectedRole: 'connector',
                expectedStatement: proof.binding,
                expectedPublicKey: proof.binding.connector_public_key_spki,
              })
              assert.equal(
                channel.sendMessage(
                  await signCameraPurposeProof(
                    proof.binding,
                    'browser',
                    keys.privateKey,
                  ),
                ),
                true,
              )
            })().catch(fail)
          }
        })
      })
      let gathered = false
      peer.onGatheringStateChange((state) => {
        if (state === 'complete') gathered = true
      })
      peer.setRemoteDescription(cmd.sdp, 'offer')
      await until(() => gathered, 'consumer ICE')
      const answer = peer.localDescription()
      assert.ok(answer)
      endpoint.answer = answer.sdp
      return { kind: 'answer', sdp: answer.sdp }
    }
    case 'bind': {
      const endpoint = endpoints.get(cmd.role)
      assert.ok(endpoint)
      await until(
        () => endpoint.channels.get('readonly-proof-v1')?.isOpen() === true,
        'consumer proof channel',
      )
      const local = endpoint.peer.localDescription(),
        remote = endpoint.peer.remoteDescription()
      assert.ok(local && remote)
      const binding = await rtcBindingFromDescriptions(
        cmd.binding,
        'browser',
        endpoint.answer,
        endpoint.offer,
      )
      assert.equal(
        endpoint.peer.remoteFingerprint().value.toUpperCase(),
        rtcDtlsFingerprint(remote.sdp),
      )
      const proof = endpoint.channels.get('readonly-proof-v1')
      assert.ok(proof)
      endpoint.readonly = new ReadonlyRtcSession({
        role: 'browser',
        binding,
        authDeadline: performance.now() + 8000,
        lifetimeDeadline: performance.now() + binding.expires_at - Date.now(),
        genuineStatus: { assignmentRefs: cmd.refs },
        onReadonly: () => {
          endpoint.ready = false
        },
        signProof: async (value) => ({
          v: value.v,
          role: 'browser',
          binding: value,
          signature: await signRtcSessionProof(
            value,
            'browser',
            keys.privateKey,
          ),
        }),
        sendProof: (wire) => {
          assert.equal(proof.sendMessage(wire), true)
        },
        sendApplication: () => {
          throw Error('Consumer cannot send status')
        },
        onVerified: () => {
          endpoint.ready = true
        },
      })
      return { kind: 'ok' }
    }
    case 'start': {
      const session = endpoints.get(cmd.role)?.readonly
      assert.ok(session)
      await session.start()
      return { kind: 'ok' }
    }
    case 'control': {
      const endpoint = endpoints.get('control')
      assert.ok(endpoint)
      await until(
        () => endpoint.channels.get('pause-control-v1')?.isOpen() === true,
        'consumer control channel',
      )
      const channel = endpoint.channels.get('pause-control-v1')
      const local = endpoint.peer.localDescription(),
        remote = endpoint.peer.remoteDescription()
      assert.ok(channel && local && remote)
      const binding = await controlBindingFromDescriptions(
        cmd.binding,
        'browser',
        endpoint.answer,
        endpoint.offer,
      )
      assert.equal(
        endpoint.peer.remoteFingerprint().value.toUpperCase(),
        rtcDtlsFingerprint(remote.sdp),
      )
      endpoint.control = new PauseControlSession({
        role: 'browser',
        privateKey: keys.privateKey,
        expected: {
          transportId: binding.transport_id,
          farmId: binding.farm_id,
          agentId: binding.agent_id,
          assignmentId: binding.assignment_id,
        },
        send: (wire) => {
          assert.equal(channel.sendMessage(wire), true)
        },
        onProofsReady: () => {
          endpoint.ready = true
        },
      })
      await endpoint.control.activate(binding)
      return { kind: 'ok' }
    }
    case 'observe':
      return {
        kind: 'observation',
        ready: [...endpoints.values()].filter((e) => e.ready).length,
        statuses,
        cameraPackets,
        cameraBytes,
      }
    case 'reset':
      reset()
      return { kind: 'ok' }
    case 'stop':
      reset()
      return { kind: 'ok' }
  }
}
const lines = createInterface({ input: process.stdin })
try {
  for await (const line of lines) {
    if (line.length > 32768) throw Error('IPC capacity')
    try {
      const cmd = Command.parse(JSON.parse(line))
      process.stdout.write(JSON.stringify(await command(cmd)) + '\n')
      if (cmd.kind === 'stop') break
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          kind: 'error',
          message: String(error).slice(0, 500),
        }) + '\n',
      )
    }
  }
} finally {
  reset()
  lines.close()
  native.cleanup()
}
