// SPDX-License-Identifier: MIT
import { randomBytes, randomInt } from 'node:crypto'
import type {
  DataChannel,
  H264RtpPacketizer,
  RtpPacketizationConfig,
  Track,
  Video,
} from 'node-datachannel'
import {
  MAX_CAMERA_PROOF_WIRE_BYTES,
  cameraStatementFromBinding,
  verifyExpectedCameraPurposeProof,
  type CameraPurposeStatement,
} from '../../../farm-protocol/src/camera-purpose-statement.ts'
import type { RtcSessionBinding } from '../../../farm-protocol/src/rtc-session-binding.ts'
import type { FixtureOnlyMediaHooks } from '../webrtc/readonly-peer.ts'
import type { AssignmentRef } from '../webrtc/readonly-session.ts'
import { startCameraSession, type CameraAccessUnit } from './session.ts'
import {
  createLocalCameraRegistry,
  type CameraConfiguration,
} from './source-policy.ts'

export const CAMERA_CHANNEL_LABEL = 'camera-purpose-v3'
export const CAMERA_VIDEO_MID = 'camera'
const PAYLOAD_TYPE = 102

/** Constructors only; injected so callers decide when the native module loads. */
export type CameraNative = Readonly<{
  Video: new (mid: string, direction: 'SendOnly') => Video
  RtpPacketizationConfig: new (
    ssrc: number,
    cname: string,
    payloadType: number,
    clockRate: number,
  ) => RtpPacketizationConfig
  H264RtpPacketizer: new (
    separator: 'StartSequence',
    config: RtpPacketizationConfig,
    maxFragmentSize: number,
  ) => H264RtpPacketizer
}>

export type ConnectorCameraMediaOptions = Readonly<{
  native: CameraNative
  /** Trusted enrollment agent id, never the received binding's. */
  expectedAgentId: string
  assignmentRefs: readonly AssignmentRef[]
  /** Local opaque handles only; scope.printerId is the assignment id. */
  cameras: readonly CameraConfiguration[]
  signProof(statement: CameraPurposeStatement): string | Promise<string>
  openSource(
    handle: string,
    signal: AbortSignal,
    expiresAtMonoMs: number,
  ): Promise<AsyncIterable<CameraAccessUnit>>
  /** Process-wide session slot; undefined when the cap is reached. */
  acquireSlot(): (() => void) | undefined
  /** Protocol violations close the whole peer (fail closed). */
  onViolation(reason: string): void
}>

type State = 'new' | 'prepared' | 'offering' | 'offered' | 'live' | 'terminal'

/** Connector side of camera-purpose V3: offer one signed statement for the
 * first configured camera in the admitted assignment set, then send H.264
 * passthrough only after the browser device countersigns that exact statement. */
export class ConnectorCameraMedia implements FixtureOnlyMediaHooks {
  #options: ConnectorCameraMediaOptions
  #registry: ReturnType<typeof createLocalCameraRegistry>
  #state: State = 'new'
  #track: Track | undefined
  #config: RtpPacketizationConfig | undefined
  #channel: DataChannel | undefined
  #statement: CameraPurposeStatement | undefined
  #binding: RtcSessionBinding | undefined
  #deadline = 0
  #abort = new AbortController()
  #session: { stop(): void } | undefined
  #rtpBase = randomInt(0, 2 ** 32)
  #sent = 0
  constructor(options: ConnectorCameraMediaOptions) {
    this.#options = Object.freeze({
      ...options,
      assignmentRefs: Object.freeze(
        options.assignmentRefs.map((ref) => Object.freeze({ ...ref })),
      ),
      cameras: Object.freeze([...options.cameras]),
    })
    this.#registry = createLocalCameraRegistry(this.#options.cameras)
  }
  prepare: FixtureOnlyMediaHooks['prepare'] = (capability) => {
    if (this.#state !== 'new') throw Error('Camera media already prepared')
    const { Video, RtpPacketizationConfig, H264RtpPacketizer } =
      this.#options.native
    const ssrc = randomInt(1, 2 ** 31)
    const video = new Video(CAMERA_VIDEO_MID, 'SendOnly')
    video.addH264Codec(
      PAYLOAD_TYPE,
      'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
    )
    video.addSSRC(ssrc, 'camera', 'camera-stream', 'camera-track')
    const config = new RtpPacketizationConfig(
      ssrc,
      'camera',
      PAYLOAD_TYPE,
      90000,
    )
    // ponytail: no NACK responder/pacer; add RtcpNackResponder for lossy networks.
    const packetizer = new H264RtpPacketizer('StartSequence', config, 1200)
    const track = capability.addVideoTrack(video)
    track.setMediaHandler(packetizer)
    track.onClosed(() => this.stopMedia())
    track.onError(() => this.stopMedia())
    const channel = capability.createDataChannel(CAMERA_CHANNEL_LABEL)
    channel.onMessage((raw) => void this.receive(raw))
    this.#track = track
    this.#config = config
    this.#channel = channel
    this.#state = 'prepared'
  }
  activate: FixtureOnlyMediaHooks['activate'] = ({
    binding,
    lifetimeDeadline,
  }) => {
    if (this.#state !== 'prepared') return this.violation('camera-activate')
    if (binding.v !== 2) return this.violation('camera-binding')
    const assigned = new Set(
      this.#options.assignmentRefs.map((ref) => ref.assignmentId),
    )
    const camera = this.#options.cameras.find(
      (entry) =>
        entry.scope.farmId === binding.farm_id &&
        entry.scope.agentId === binding.agent_id &&
        entry.scope.agentId === this.#options.expectedAgentId &&
        assigned.has(entry.scope.printerId),
    )
    // No camera for this assignment set: the channel stays idle (unavailable).
    if (!camera) return
    this.#binding = binding
    this.#deadline = Math.min(
      lifetimeDeadline,
      performance.now() + binding.expires_at - Date.now(),
    )
    this.#statement = cameraStatementFromBinding(binding, {
      camera_id: camera.cameraId,
      printer_id: camera.scope.printerId,
      video_mid: CAMERA_VIDEO_MID,
      lease_ref: randomBytes(16).toString('base64url'),
    })
    this.#state = 'offering'
    void Promise.resolve()
      .then(() => this.#options.signProof(this.#statement!))
      .then((wire) => {
        if (this.#state !== 'offering') return
        if (!this.#channel?.sendMessage(wire))
          return this.violation('camera-offer-send')
        this.#state = 'offered'
      })
      .catch(() => this.violation('camera-offer-sign'))
  }
  private async receive(raw: unknown) {
    if (
      this.#state !== 'offered' ||
      typeof raw !== 'string' ||
      raw.length > MAX_CAMERA_PROOF_WIRE_BYTES
    )
      return this.violation('camera-frame')
    this.#state = 'live'
    const statement = this.#statement!,
      binding = this.#binding!
    const proof = await verifyExpectedCameraPurposeProof({
      expectedStatement: statement,
      expectedRole: 'browser',
      expectedPublicKey: binding.browser_public_key,
      wire: raw,
    })
    if (this.#state !== 'live') return
    if (!proof) return this.violation('camera-proof')
    if (performance.now() >= this.#deadline || Date.now() >= binding.expires_at)
      return this.stopMedia()
    const release = this.#options.acquireSlot()
    if (!release) return this.stopMedia()
    const scope = {
      farmId: statement.farm_id,
      agentId: statement.agent_id,
      printerId: statement.printer_id,
    }
    const session = startCameraSession({
      cameraId: statement.camera_id,
      scope,
      lease: {
        cameraId: statement.camera_id,
        scope,
        expiresAt: this.#deadline,
        signal: this.#abort.signal,
      },
      registry: this.#registry,
      openSource: (handle, signal) =>
        this.#options.openSource(handle, signal, this.#deadline),
      sink: {
        trySend: (unit) => this.send(unit),
        close: () => this.stopMedia(),
      },
    })
    this.#session = session
    void session.done.finally(release)
  }
  private send(unit: CameraAccessUnit): 'sent' | 'closed' {
    const track = this.#track,
      config = this.#config
    if (this.#state !== 'live' || !track?.isOpen() || !config) return 'closed'
    config.timestamp = Number(
      (BigInt(this.#rtpBase) + (BigInt(unit.timestampUs) * 9n) / 100n) %
        4294967296n,
    )
    const sent = track.sendMessageBinary(
      Buffer.from(unit.data.buffer, unit.data.byteOffset, unit.data.byteLength),
    )
    if (sent) this.#sent = Math.min(1_000_000, this.#sent + 1)
    return sent ? 'sent' : 'closed'
  }
  /** Ends media only; the peer and its status channel continue. */
  private stopMedia() {
    if (this.#state === 'terminal') return
    this.#state = 'terminal'
    this.#abort.abort()
    this.#session?.stop()
    try {
      this.#track?.close()
    } catch {
      /* Native close is best effort after terminal state. */
    }
  }
  private violation(reason: string) {
    if (this.#state === 'terminal') return
    this.stopMedia()
    this.#options.onViolation(reason)
  }
  /** Synchronous revocation: no access unit is submitted after this returns. */
  stop = () => {
    this.stopMedia()
    try {
      this.#channel?.close()
    } catch {
      /* Peer close owns the transport. */
    }
  }
  snapshot() {
    return Object.freeze({
      state: this.#state,
      trackOpen: this.#track?.isOpen() ?? false,
      sent: this.#sent,
    })
  }
}
