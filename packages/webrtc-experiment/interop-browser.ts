import {
  SyntheticSession,
  SYNTHETIC_LIMITS,
  transcript,
  encodeHex,
  decodeHex,
  dtlsFingerprint,
  type Scope,
} from '../connector/src/webrtc/synthetic-session.ts'
export type InteropScenario =
  | 'valid'
  | 'wrong-identity'
  | 'substitution'
  | 'replay'
  | 'timeout'
  | 'closed'
  | 'tampered-offer'
  | 'tampered-answer'
  | 'pre-cert-overload'
  | 'status-flood'
const key = () =>
  crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
const browserKey = key(),
  strangerKey = key()
let peer: RTCPeerConnection | undefined
let session: SyntheticSession | undefined
let oldProof: string | undefined
let channel: RTCDataChannel | undefined
let blockedProof: string | undefined
let closeCurrent: ((reason: string) => void) | undefined
let sendCurrent: ((frame: string) => boolean) | undefined
const STATUS = JSON.stringify({
  kind: 'synthetic-status',
  value: 'fixture-idle',
})
type Evidence = {
  actualRemoteFingerprint: string | undefined
  fingerprintMatches: boolean
  receivedRtc: number
  sent: number
  rtcProofsSent: number
  rtcProofsReceived: number
  closeCount: number
  receiveEnabled: boolean
  activationTasks: number
  sawDtlsFailure: boolean
}
const freshEvidence = (): Evidence => ({
  actualRemoteFingerprint: undefined,
  fingerprintMatches: false,
  receivedRtc: 0,
  sent: 0,
  rtcProofsSent: 0,
  rtcProofsReceived: 0,
  closeCount: 0,
  receiveEnabled: true,
  activationTasks: 0,
  sawDtlsFailure: false,
})
let evidence = freshEvidence()
export async function publicIdentity() {
  return encodeHex(
    await crypto.subtle.exportKey('spki', (await browserKey).publicKey),
  )
}
async function gathered(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(Error('Browser ICE deadline'))
    }, 3000)
    const change = () => {
      if (connection.iceGatheringState === 'complete') {
        cleanup()
        resolve()
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      connection.removeEventListener('icegatheringstatechange', change)
    }
    connection.addEventListener('icegatheringstatechange', change)
    change()
  })
}
export async function answer(input: {
  scenario: InteropScenario
  scope: Scope
  offer: { type: 'offer'; sdp: string }
}) {
  dispose()
  blockedProof = undefined
  const observed = freshEvidence()
  evidence = observed
  const connection = new RTCPeerConnection({ iceServers: [] })
  peer = connection
  let localSession: SyntheticSession | undefined,
    localChannel: RTCDataChannel | undefined
  let terminalReason: string | undefined
  let activationStarted = false
  let releaseCertificate: () => void = () => {}
  // Fixture-only held certificate gate, one task, no per-message awaiters.
  const certificateGate =
    input.scenario === 'pre-cert-overload'
      ? new Promise<void>((resolve) => {
          releaseCertificate = resolve
        })
      : Promise.resolve()
  let authTimer: ReturnType<typeof setTimeout> | undefined
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  const terminal = (reason: string) => {
    if (terminalReason) return
    terminalReason = reason
    observed.receiveEnabled = false
    observed.closeCount++
    clearTimeout(authTimer)
    clearTimeout(lifetimeTimer)
    if (localChannel) {
      localChannel.onmessage = null
      localChannel.onopen = null
      localChannel.onclose = null
      localChannel.onerror = null
    }
    connection.ondatachannel = null
    connection.onconnectionstatechange = null
    localSession?.readonly(reason)
    releaseCertificate()
    localChannel?.close()
    connection.close()
  }
  closeCurrent = terminal
  authTimer = setTimeout(() => terminal('deadline'), SYNTHETIC_LIMITS.authMs)
  lifetimeTimer = setTimeout(
    () => terminal('fixture-lifetime'),
    SYNTHETIC_LIMITS.lifetimeMs,
  )
  const send = (frame: string) => {
    if (terminalReason || !localChannel || localChannel.readyState !== 'open')
      return false
    localChannel.send(frame)
    observed.sent = Math.min(observed.sent + 1, SYNTHETIC_LIMITS.observedEvents)
    if (frame.startsWith('{"kind":"proof"'))
      observed.rtcProofsSent = Math.min(
        observed.rtcProofsSent + 1,
        SYNTHETIC_LIMITS.observedEvents,
      )
    return true
  }
  sendCurrent = send
  const activate = async () => {
    if (
      activationStarted ||
      terminalReason ||
      !localSession ||
      localChannel?.readyState !== 'open'
    )
      return
    activationStarted = true
    observed.activationTasks++
    try {
      await certificateGate
      if (terminalReason) return
      const report = await connection.getStats()
      if (terminalReason) return
      const stats = new Map<string, unknown>()
      report.forEach((value: unknown, id) => {
        stats.set(id, value)
      })
      let remoteCertificateId: string | undefined
      for (const stat of stats.values()) {
        if (
          stat &&
          typeof stat === 'object' &&
          'type' in stat &&
          stat.type === 'transport' &&
          'remoteCertificateId' in stat &&
          typeof stat.remoteCertificateId === 'string'
        )
          remoteCertificateId = stat.remoteCertificateId
      }
      const stat = remoteCertificateId
        ? stats.get(remoteCertificateId)
        : undefined
      if (
        stat &&
        typeof stat === 'object' &&
        'fingerprint' in stat &&
        typeof stat.fingerprint === 'string' &&
        'fingerprintAlgorithm' in stat &&
        stat.fingerprintAlgorithm === 'sha-256' &&
        connection.remoteDescription
      ) {
        observed.actualRemoteFingerprint = stat.fingerprint.toUpperCase()
        observed.fingerprintMatches =
          observed.actualRemoteFingerprint ===
          dtlsFingerprint(connection.remoteDescription.sdp)
      }
      if (!observed.fingerprintMatches) {
        terminal('actual-certificate-mismatch')
        return
      }
      localSession.activate()
      await localSession.start()
    } catch {
      terminal('actual-certificate-unavailable')
    }
  }
  connection.onconnectionstatechange = () => {
    if (terminalReason) return
    observed.sawDtlsFailure ||= connection.sctp?.transport.state === 'failed'
    if (
      ['failed', 'disconnected', 'closed'].includes(connection.connectionState)
    )
      terminal('transport-' + connection.connectionState)
  }
  connection.ondatachannel = (event) => {
    if (terminalReason) {
      event.channel.close()
      return
    }
    if (localChannel || event.channel.label !== 'synthetic-node-v1') {
      event.channel.close()
      terminal('unexpected-channel')
      return
    }
    localChannel = event.channel
    channel = localChannel
    localChannel.onmessage = (event) => {
      if (terminalReason) return
      observed.receivedRtc = Math.min(
        observed.receivedRtc + 1,
        SYNTHETIC_LIMITS.observedEvents,
      )
      if (!localSession) {
        terminal('message-before-session')
        return
      }
      if (
        typeof event.data === 'string' &&
        event.data.length <= SYNTHETIC_LIMITS.frameBytes &&
        event.data.startsWith('{"kind":"proof"')
      )
        observed.rtcProofsReceived = Math.min(
          observed.rtcProofsReceived + 1,
          SYNTHETIC_LIMITS.observedEvents,
        )
      void localSession.receive(event.data)
    }
    localChannel.onclose = () => terminal('channel-closed')
    localChannel.onerror = () => terminal('channel-error')
    localChannel.onopen = () => {
      void activate()
    }
    if (localChannel.readyState === 'open') void activate()
  }
  try {
    await connection.setRemoteDescription(input.offer)
    await connection.setLocalDescription(await connection.createAnswer())
    await gathered(connection)
    if (
      terminalReason ||
      !connection.localDescription ||
      !connection.remoteDescription
    )
      throw Error('Browser descriptions missing or terminal')
    const binding = transcript(
      input.scope,
      'browser',
      connection.localDescription.sdp,
      connection.remoteDescription.sdp,
    )
    const remotePublicKey = await crypto.subtle.importKey(
      'spki',
      decodeHex(input.scope.connectorSpki),
      'Ed25519',
      false,
      ['verify'],
    )
    if (terminalReason) throw Error('Browser terminal')
    localSession = new SyntheticSession({
      role: 'browser',
      waitForTransport: true,
      binding:
        input.scenario === 'substitution'
          ? binding.replace(
              /(?:[A-F0-9]{2}:){31}[A-F0-9]{2}/,
              '00:'.repeat(31) + '00',
            )
          : binding,
      privateKey: (
        await (input.scenario === 'wrong-identity' ? strangerKey : browserKey)
      ).privateKey,
      remotePublicKey,
      send: (frame) => {
        if (input.scenario === 'timeout') {
          if (frame.startsWith('{"kind":"proof"')) blockedProof = frame
          return
        }
        if (frame.startsWith('{"kind":"proof"')) {
          if (input.scenario === 'replay') {
            if (!oldProof || !send(oldProof)) throw Error('Replay send failed')
            return
          }
          if (input.scenario === 'valid') oldProof = frame
        }
        if (!send(frame)) throw Error('Browser send failed')
      },
      onVerified: () => {
        clearTimeout(authTimer)
        authTimer = undefined
      },
      onReadonly: () => {
        const state = localSession?.state
        terminal(state?.kind === 'readonly' ? state.reason : 'session-readonly')
      },
    })
    session = localSession
    if (terminalReason) localSession.readonly(terminalReason)
    void activate()
    return {
      type: 'answer',
      sdp: connection.localDescription.sdp,
    } satisfies RTCSessionDescriptionInit
  } catch (error) {
    terminal('browser-negotiation-failed')
    throw error
  }
}
export function snapshot() {
  const pair = peer?.sctp?.transport.iceTransport.getSelectedCandidatePair()
  return {
    ...session?.snapshot(),
    connection: peer?.connectionState,
    dtls: peer?.sctp?.transport.state,
    candidates: pair
      ? { local: pair.local.type, remote: pair.remote.type }
      : null,
    channel: channel?.readyState,
    iceServers: peer?.getConfiguration().iceServers,
    heldProof: blockedProof !== undefined,
    ...evidence,
    expectedRemoteFingerprint: peer?.remoteDescription
      ? dtlsFingerprint(peer.remoteDescription.sdp)
      : undefined,
  }
}
/** Bounded malicious-fixture sender; never a Connector application send path. */
export function flood(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 1200)
    throw Error('Fixture flood limit')
  let sent = 0
  for (let i = 0; i < count; i++) {
    if (!sendCurrent?.(STATUS)) break
    sent++
  }
  return sent
}
export function closePeer() {
  closeCurrent?.('transport-closed')
}
export function attemptAfterReadonly() {
  void session?.start()
  return { sentStatus: session?.sendStatus() ?? false }
}
export function dispose() {
  closeCurrent?.('disposed')
  closeCurrent = undefined
  sendCurrent = undefined
  session = undefined
  channel = undefined
  peer = undefined
}
