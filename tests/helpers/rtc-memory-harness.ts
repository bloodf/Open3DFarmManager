// SPDX-License-Identifier: MIT
// Synthetic local admission, production Connector sessions/senders, native SCTP/RTP.
// No command dispatcher, printer driver, HTTP command fallback or hardware access.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { appendFile, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  native,
  Reply,
  type Command,
  type Role,
  until,
} from './rtc-memory-wire.ts'
import type { DataChannel, Track } from 'node-datachannel'
import { ReadonlyConnectorPeer } from '../../packages/connector/src/webrtc/readonly-peer.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  ReadonlyRtcSession,
  type VerifiedRtcAdmission,
} from '../../packages/connector/src/webrtc/readonly-session.ts'
import {
  FarmStatusSender,
  FARM_STATUS_PENDING_BYTES,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { PauseControlSession } from '../../packages/connector/src/webrtc/pause-control-session.ts'
import { ConnectorCameraMedia } from '../../packages/connector/src/camera/camera-media.ts'
import {
  RtcSessionBinding,
  rtcSdpHash,
  rtcDtlsFingerprint,
  decodeRtcProof,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import { ControlSessionBinding } from '../../packages/farm-protocol/src/control-session-binding.ts'
import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'

export async function createRtcMemoryHarness(ledger: string) {
  const child = spawn(
    process.execPath,
    [new URL('./rtc-memory-consumer.ts', import.meta.url).pathname],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENFARM_RTC_MEMORY: '1' },
    },
  )
  await appendFile(
    ledger,
    JSON.stringify({ event: 'consumer-start', pid: child.pid }) + '\n',
  )
  const closed = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096)
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  async function request(command: Command) {
    assert.ok(child.stdin.write(JSON.stringify(command) + '\n'))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Consumer RPC deadline: ' + stderr)),
            10000,
          )
        }),
      ])
      if (result.done) throw Error('Consumer exited: ' + stderr)
      assert.ok(result.value.length <= 32768)
      const reply = Reply.parse(JSON.parse(result.value))
      if (reply.kind === 'error') throw Error(reply.message)
      return reply
    } finally {
      clearTimeout(timer)
    }
  }
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const agentId = randomUUID(),
    farmId = randomUUID(),
    assignmentId = randomUUID()
  const refs = [{ agentId, assignmentId, printerKey: 'memory-printer' }]
  const assignments = await assignmentSetDigest({ farmId, agentId }, refs)
  const channels = new Map<string, DataChannel | Track>()
  const peers: InstanceType<typeof native.PeerConnection>[] = []
  const sessions: ReadonlyRtcSession[] = []
  let statusPeer: ReadonlyConnectorPeer | undefined
  let control: PauseControlSession | undefined
  let camera: ConnectorCameraMedia | undefined
  let sender: FarmStatusSender | undefined
  let publish: (() => void) | undefined
  let ready = 0,
    generations = 0,
    produced = 0,
    sent = 0,
    suppressed = 0
  let cameraProduced = 0,
    cameraSentBefore = 0
  let peakBuffered = 0,
    boundHits = 0,
    stopped = false
  let closing = false
  let failure: string | undefined
  const readChannels = () =>
    Object.fromEntries(
      [...channels].map(([name, channel]) => [
        name,
        typeof channel.bufferedAmount === 'function'
          ? channel.bufferedAmount()
          : null,
      ]),
    )
  const check = () => {
    if (failure) throw Error(failure)
  }
  function resetLocal() {
    closing = true
    cameraSentBefore += camera?.snapshot().sent ?? 0
    sender?.close('memory-renewal')
    statusPeer?.close('memory-renewal')
    statusPeer = undefined
    camera?.stop()
    control?.close('memory-renewal')
    for (const session of sessions) session.close('memory-renewal')
    for (const peer of peers) peer.close()
    channels.clear()
    peers.length = 0
    sessions.length = 0
    sender = undefined
    camera = undefined
    control = undefined
    publish = undefined
    ready = 0
    closing = false
  }
  async function close() {
    if (stopped) return
    stopped = true
    child.kill('SIGCONT')
    resetLocal()
    try {
      await request({ kind: 'stop' })
    } catch {
      child.kill('SIGTERM')
    }
    child.stdin.end()
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
    await closed
    clearTimeout(kill)
    native.cleanup()
    await appendFile(
      ledger,
      JSON.stringify({
        event: 'consumer-closed',
        pid: child.pid,
        exitCode: child.exitCode,
        signal: child.signalCode,
      }) + '\n',
    )
  }
  try {
    const hello = await request({ kind: 'hello' })
    assert.equal(hello.kind, 'hello')
    if (hello.kind !== 'hello') throw Error('Consumer hello missing')
    const { publicKey, thumbprint } = hello
    async function connect(role: Role) {
      if (role === 'status') {
        const admitted = Promise.withResolvers<unknown>()
        let listener: (value: VerifiedRtcAdmission) => void = () => {}
        const peer = new ReadonlyConnectorPeer({
          identity,
          expectedAgentId: agentId,
          admittedBinding: admitted.promise,
          genuineStatus: { assignmentRefs: refs },
          onVerifiedAdmission: (value) => {
            ready++
            listener(value)
          },
          onTerminal: (reason) => {
            if (!closing) failure = 'ReadonlyConnectorPeer terminal: ' + reason
          },
        })
        statusPeer = peer
        sender = new FarmStatusSender({
          assignmentRefs: refs,
          signal: new AbortController().signal,
          client: {
            start: async () => {},
            subscribeVerifiedAdmission: (fn) => {
              listener = fn
              return () => {
                listener = () => {}
              }
            },
            subscribeTerminal: () => () => {},
            bufferedAmount: () => peer.bufferedStatusAmount(),
            sendStatus: (message) => {
              const ok = peer.sendStatus(message)
              if (ok) sent++
              return ok
            },
            close: (reason) => {
              if (!closing) failure ??= 'FarmStatusSender terminal: ' + reason
            },
          },
          openSnapshots: (input) => {
            publish = () => {
              check()
              const before = sent
              produced++
              input.onComplete({
                assignmentRefs: refs,
                complete: true,
                printers: [
                  {
                    printerKey: 'memory-printer',
                    state: 'printing',
                    progress: 0.5,
                    observedAt: Date.now(),
                    identity: { model: 'M'.repeat(1024) },
                    filename: 'F'.repeat(255),
                  },
                ],
                capturedAtMonoMs: performance.now(),
                validUntilMonoMs: input.deadlineMonoMs,
              })
              const buffered = peer.bufferedStatusAmount()
              peakBuffered = Math.max(peakBuffered, buffered)
              if (sent === before && !failure) {
                suppressed++
                boundHits++
              }
              check()
            }
            return {
              close() {
                publish = undefined
              },
            }
          },
        })
        const offer = await peer.offer()
        const answer = await request({ kind: 'offer', role, sdp: offer })
        if (answer.kind !== 'answer') throw Error('Missing status answer')
        peer.answer(answer.sdp)
        const now = Date.now()
        const binding = RtcSessionBinding.parse({
          v: 2,
          purpose: 'read-only-rtc',
          commands_enabled: false,
          transport_id: randomUUID(),
          farm_id: farmId,
          agent_id: agentId,
          account_id: 'memory-fixture',
          key_id: randomUUID(),
          browser_public_key: publicKey,
          browser_thumbprint: thumbprint,
          connector_public_key_spki: identity.publicKeySpki,
          connector_fingerprint: identity.fingerprint,
          credential_jti: randomUUID(),
          origin: 'https://memory.example',
          audience: 'open3dfarmmanager:connector',
          browser_nonce: randomBytes(32).toString('base64url'),
          connector_nonce: randomBytes(32).toString('base64url'),
          issued_at: now,
          expires_at: now + 28000,
          offer_sha256: await rtcSdpHash(offer),
          answer_sha256: await rtcSdpHash(answer.sdp),
          connector_dtls: rtcDtlsFingerprint(offer),
          browser_dtls: rtcDtlsFingerprint(answer.sdp),
          assignment_count: assignments.count,
          assignment_digest: assignments.digest,
        })
        // The native peer waits for trusted admission, so install the consumer first.
        await request({ kind: 'bind', role, binding, refs })
        admitted.resolve(binding)
        await until(
          () => peer.snapshot().stage === 'role-proofs',
          'status role proofs',
        )
        await request({ kind: 'start', role })
        return
      }
      const peer = new native.PeerConnection('memory-connector-' + role, {
        iceServers: [],
        bindAddress: '127.0.0.1',
        enableIceTcp: false,
        disableAutoNegotiation: true,
        maxMessageSize: 8192,
      })
      peers.push(peer)
      const addChannel = (label: string) => {
        const channel = peer.createDataChannel(label, { unordered: false })
        channels.set(role + '/' + label, channel)
        return channel
      }
      const proof = addChannel(
        role === 'control' ? 'pause-control-v1' : 'readonly-proof-v1',
      )
      const application =
        role === 'control'
          ? undefined
          : addChannel('readonly-fixture-status-v1')
      if (role === 'camera') {
        camera = new ConnectorCameraMedia({
          native,
          expectedAgentId: agentId,
          assignmentRefs: refs,
          cameras: [
            {
              cameraId: 'memory-camera',
              scope: { farmId, agentId, printerId: assignmentId },
              sourceHandle: 'synthetic-h264',
            },
          ],
          signProof: (statement) =>
            identity.signCameraPurposeProof({
              statement,
              expectedAgentId: agentId,
            }),
          acquireSlot: () => () => {},
          onViolation: (reason) => {
            failure = 'Camera violation: ' + reason
          },
          openSource: async (_handle, signal) =>
            (async function* () {
              // Synthetic Annex-B IDR payload exercises packetization/allocation, not decoding.
              const data = new Uint8Array(32768).fill(0x55)
              data.set([0, 0, 0, 1, 0x65])
              let timestampUs = 0
              while (!signal.aborted) {
                cameraProduced++
                yield {
                  data,
                  keyframe: true,
                  timestampUs: (timestampUs += 50000),
                }
                await delay(50, undefined, { signal }).catch(() => {})
              }
            })(),
        })
        camera.prepare({
          addVideoTrack: (video) => {
            const track = peer.addTrack(video)
            channels.set('camera/rtp', track)
            return track
          },
          createDataChannel: addChannel,
        })
      }
      let gathered = false
      peer.onGatheringStateChange((state) => {
        if (state === 'complete') gathered = true
      })
      peer.setLocalDescription('offer')
      await until(() => gathered, role + ' Connector ICE')
      const offer = peer.localDescription()
      assert.ok(offer)
      const answer = await request({ kind: 'offer', role, sdp: offer.sdp })
      assert.equal(answer.kind, 'answer')
      if (answer.kind !== 'answer') throw Error('Missing answer')
      peer.setRemoteDescription(answer.sdp, 'answer')
      await until(
        () => proof.isOpen() && (!application || application.isOpen()),
        role + ' Connector channel',
      )
      assert.equal(peer.remoteFingerprint().algorithm, 'sha-256')
      assert.equal(
        peer.remoteFingerprint().value.toUpperCase(),
        rtcDtlsFingerprint(answer.sdp),
      )
      const now = Date.now()
      const base = {
        transport_id: randomUUID(),
        farm_id: farmId,
        agent_id: agentId,
        account_id: 'memory-fixture',
        key_id: randomUUID(),
        browser_public_key: publicKey,
        browser_thumbprint: thumbprint,
        connector_public_key_spki: identity.publicKeySpki,
        connector_fingerprint: identity.fingerprint,
        credential_jti: randomUUID(),
        origin: 'https://memory.example',
        audience: 'open3dfarmmanager:connector',
        browser_nonce: randomBytes(32).toString('base64url'),
        connector_nonce: randomBytes(32).toString('base64url'),
        issued_at: now,
        expires_at: now + 28000,
        offer_sha256: await rtcSdpHash(offer.sdp),
        answer_sha256: await rtcSdpHash(answer.sdp),
        connector_dtls: rtcDtlsFingerprint(offer.sdp),
        browser_dtls: rtcDtlsFingerprint(answer.sdp),
      }
      if (role === 'control') {
        const binding = ControlSessionBinding.parse({
          ...base,
          v: 1,
          purpose: 'pause-rtc',
          assignment_id: assignmentId,
        })
        control = new PauseControlSession({
          role: 'connector',
          identity,
          expected: {
            transportId: binding.transport_id,
            farmId,
            agentId,
            assignmentId,
          },
          send: (wire) => {
            assert.equal(proof.sendMessage(wire), true)
          },
          onProofsReady: () => {
            ready++
          },
          onTerminal: (reason) => {
            if (!closing) failure = 'Control terminal: ' + reason
          },
        })
        proof.onMessage((raw) => control?.receive(raw))
        await request({ kind: 'control', binding })
        await control.activate(binding)
      } else {
        assert.ok(application)
        const binding = RtcSessionBinding.parse({
          ...base,
          v: 2,
          purpose: 'read-only-rtc',
          commands_enabled: false,
          assignment_count: assignments.count,
          assignment_digest: assignments.digest,
        })
        const deadline = performance.now() + binding.expires_at - Date.now()
        const session = new ReadonlyRtcSession({
          role: 'connector',
          binding,
          authDeadline: performance.now() + 8000,
          lifetimeDeadline: deadline,
          genuineStatus: { assignmentRefs: refs },
          signProof: (value) =>
            identity.signRtcSessionProof({
              binding: value,
              expectedAgentId: agentId,
            }),
          sendProof: (wire) => {
            assert.equal(proof.sendMessage(wire), true)
          },
          sendApplication: (wire) => {
            const result = application.sendMessage(wire)
            assert.equal(result, true)
          },
          onVerified: () => {
            ready++
            if (role === 'camera')
              camera?.activate({ binding, lifetimeDeadline: deadline })
          },
          onReadonly: () => {
            if (!closing) failure = role + ' session terminal'
          },
        })
        sessions.push(session)
        proof.onMessage((raw) => {
          void session
            .inspectProof(decodeRtcProof(raw))
            .catch((error: unknown) => {
              failure = String(error)
            })
        })
        await request({ kind: 'bind', role, binding, refs })
        await session.start()
        await request({ kind: 'start', role })
      }
    }
    async function renew() {
      resetLocal()
      await request({ kind: 'reset' })
      await connect('status')
      await connect('camera')
      await connect('control')
      await until(() => {
        check()
        return ready === 3 && !!publish && camera?.snapshot().state === 'live'
      }, 'all Connector peers')
      const observation = await request({ kind: 'observe' })
      assert.equal(observation.kind, 'observation')
      if (observation.kind === 'observation') assert.equal(observation.ready, 3)
      generations++
      await appendFile(
        ledger,
        JSON.stringify({ event: 'generation-ready', generations }) + '\n',
      )
    }
    async function pressure(sample: () => Promise<void>) {
      assert.ok(child.pid)
      child.kill('SIGSTOP')
      try {
        let paused = false
        for (let i = 0; i < 100 && !paused; i++) {
          paused = /^State:\s+T/m.test(
            await readFile('/proc/' + child.pid + '/status', 'utf8'),
          )
          if (!paused) await delay(10)
        }
        assert.ok(paused, 'Consumer process must actually stop')
        // 900 admitted frames stay below the 1024/session safety cap; further
        // producer attempts are suppressed by FarmStatusSender's real native bound.
        const firstSent = sent
        for (let i = 0; i < 4000 && sent - firstSent < 900; i++) {
          publish?.()
          if (i % 100 === 0) await sample()
        }
        await sample()
        await delay(1000)
      } catch (error) {
        await sample()
        throw error
      } finally {
        child.kill('SIGCONT')
      }
      await until(
        () => {
          check()
          return statusPeer?.bufferedStatusAmount() === 0
        },
        'status drain',
        4000,
      )
      publish?.() // Clears the sender's backpressure timer after native drain.
      check()
    }
    return {
      renew,
      pressure,
      close,
      tick() {
        check()
        publish?.()
      },
      async observeConsumer() {
        return request({ kind: 'observe' })
      },
      observe() {
        const amounts = {
          ...readChannels(),
          'status/readonly-fixture-status-v1':
            statusPeer?.bufferedStatusAmount() ?? null,
          'status/readonly-proof-v1': null,
        }
        const bufferedAmountBytes = Math.max(
          0,
          ...Object.values(amounts).filter((value) => value !== null),
        )
        peakBuffered = Math.max(peakBuffered, bufferedAmountBytes)
        return {
          channels: amounts,
          bufferedAmountBytes,
          sendQueueBytes: 0,
          ready:
            (statusPeer?.snapshot().state === 'verified' ? 1 : 0) +
            sessions.filter(
              (session) => session.snapshot().state === 'verified',
            ).length +
            (control?.diagnostics().proofsReady &&
            !control.diagnostics().terminal
              ? 1
              : 0),
          failure: failure ?? null,
          statusSnapshot: statusPeer?.snapshot(),
          generations,
          producedStatusFrames: produced,
          sentStatusFrames: sent,
          suppressedStatusFrames: suppressed,
          boundHits,
          peakBufferedAmountBytes: peakBuffered,
          cameraProducedFrames: cameraProduced,
          cameraSentFrames: cameraSentBefore + (camera?.snapshot().sent ?? 0),
          cameraState: camera?.snapshot().state,
          statusBoundBytes: FARM_STATUS_PENDING_BYTES,
          native: native.getLibraryVersion(),
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
