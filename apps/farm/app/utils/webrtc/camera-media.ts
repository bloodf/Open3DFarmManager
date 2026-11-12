import {
  MAX_CAMERA_PROOF_WIRE_BYTES,
  cameraStatementFromBinding,
  decodeCameraPurposeProof,
  signCameraPurposeProof,
  verifyExpectedCameraPurposeProof,
} from '../../../../../packages/farm-protocol/src/camera-purpose-statement.ts'
import type { RtcSessionBinding } from '../../../../../packages/farm-protocol/src/rtc-session-binding.ts'

export const CAMERA_CHANNEL_LABEL = 'camera-purpose-v3'

export type BrowserCameraHooks = Readonly<{
  onTrack: (
    event: Readonly<{
      track: MediaStreamTrack
      receiver: RTCRtpReceiver
      mid: string | null
    }>,
  ) => void
  onChannel: (channel: RTCDataChannel) => void
  activate: (
    context: Readonly<{ binding: RtcSessionBinding; lifetimeDeadline: number }>,
  ) => void
  stop: () => void
}>

type State = 'waiting' | 'verifying' | 'live' | 'terminal'

/** Browser side of camera-purpose V3. Attaches the received track only after the
 * Connector's signed statement matches the admitted binding, names an assignment
 * this view authorized and the actual track MID, and this device countersigned it. */
export class BrowserCameraMedia implements BrowserCameraHooks {
  #options: Readonly<{
    privateKey: CryptoKey
    authorizedPrinterIds: ReadonlySet<string>
    onStream: (stream: MediaStream | null, printerId?: string) => void
    onViolation: (reason: string) => void
  }>
  #state: State = 'waiting'
  #track: MediaStreamTrack | undefined
  #mid: string | null = null
  #channel: RTCDataChannel | undefined
  #binding: RtcSessionBinding | undefined
  #offer: string | undefined
  #attached = false
  constructor(options: {
    privateKey: CryptoKey
    authorizedPrinterIds: readonly string[]
    onStream: (stream: MediaStream | null, printerId?: string) => void
    onViolation: (reason: string) => void
  }) {
    this.#options = Object.freeze({
      ...options,
      authorizedPrinterIds: new Set(options.authorizedPrinterIds),
    })
  }
  onTrack: BrowserCameraHooks['onTrack'] = ({ track, mid }) => {
    if (this.#state === 'terminal' || this.#track || track.kind !== 'video') {
      track.stop()
      return this.violation('camera-track')
    }
    this.#track = track
    this.#mid = mid
    track.onended = () => this.detach()
  }
  onChannel: BrowserCameraHooks['onChannel'] = (channel) => {
    if (this.#state === 'terminal' || this.#channel) {
      channel.close()
      return this.violation('camera-channel')
    }
    this.#channel = channel
    // Closing the camera channel declines or ends only the camera.
    channel.onclose = () => this.stop()
    channel.onmessage = ({ data }) => {
      if (
        this.#offer !== undefined ||
        typeof data !== 'string' ||
        data.length > MAX_CAMERA_PROOF_WIRE_BYTES
      )
        return this.violation('camera-frame')
      this.#offer = data
      this.consider()
    }
  }
  activate: BrowserCameraHooks['activate'] = ({ binding }) => {
    if (this.#state !== 'waiting' || this.#binding) return
    this.#binding = binding
    this.consider()
  }
  private consider() {
    const binding = this.#binding,
      wire = this.#offer
    if (this.#state !== 'waiting' || !binding || wire === undefined) return
    this.#state = 'verifying'
    void this.verify(binding, wire).catch(() => this.violation('camera-verify'))
  }
  private async verify(binding: RtcSessionBinding, wire: string) {
    const offered = decodeCameraPurposeProof(wire).binding
    if (
      !this.#options.authorizedPrinterIds.has(offered.printer_id) ||
      !this.#track ||
      this.#mid !== offered.video_mid
    )
      return this.stop() // Not authorized here: decline the camera only.
    // Every transport, identity, assignment and lifetime field comes from the
    // admitted binding; only the camera fields are taken from the offer.
    const expected = cameraStatementFromBinding(binding, offered)
    const proof = await verifyExpectedCameraPurposeProof({
      expectedStatement: expected,
      expectedRole: 'connector',
      expectedPublicKey: binding.connector_public_key_spki,
      wire,
    })
    if (this.#state !== 'verifying') return
    if (!proof) return this.violation('camera-proof')
    const answer = await signCameraPurposeProof(
      expected,
      'browser',
      this.#options.privateKey,
    )
    if (this.#state !== 'verifying') return
    if (this.#channel?.readyState !== 'open')
      return this.violation('camera-channel')
    this.#channel.send(answer)
    this.#state = 'live'
    this.#attached = true
    this.#options.onStream(new MediaStream([this.#track]), offered.printer_id)
  }
  private detach() {
    if (!this.#attached) return
    this.#attached = false
    this.#options.onStream(null)
  }
  private violation(reason: string) {
    if (this.#state === 'terminal') return
    this.stop()
    this.#options.onViolation(reason)
  }
  /** Synchronous revocation: detaches before returning. */
  stop = () => {
    if (this.#state === 'terminal') return
    this.#state = 'terminal'
    this.detach()
    if (this.#track) {
      this.#track.onended = null
      this.#track.stop()
    }
    if (this.#channel) {
      this.#channel.onmessage = null
      this.#channel.onclose = null
      this.#channel.close()
    }
  }
  snapshot() {
    return Object.freeze({ state: this.#state, attached: this.#attached })
  }
}
