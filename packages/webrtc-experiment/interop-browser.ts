import {
  SyntheticSession,
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
const key = () =>
  crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
const browserKey = key()
const strangerKey = key()
let peer: RTCPeerConnection | undefined
let session: SyntheticSession | undefined
let oldProof: string | undefined
let channel: RTCDataChannel | undefined
let blockedProof: string | undefined
type CertificateEvidence = {
  actualRemoteFingerprint: string | undefined
  fingerprintMatches: boolean
}
let certificateEvidence: CertificateEvidence = {
  actualRemoteFingerprint: undefined,
  fingerprintMatches: false,
}
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
  const evidence: CertificateEvidence = {
    actualRemoteFingerprint: undefined,
    fingerprintMatches: false,
  }
  certificateEvidence = evidence
  const connection = new RTCPeerConnection({ iceServers: [] })
  peer = connection
  let localSession: SyntheticSession | undefined
  let localChannel: RTCDataChannel | undefined
  let certificateCheck: Promise<boolean> | undefined
  const checkCertificate = () =>
    (certificateCheck ??= (async () => {
      const report = await connection.getStats()
      const stats = new Map<string, unknown>()
      report.forEach((value: unknown, id) => {
        stats.set(id, value)
      })
      let remoteCertificateId: string | undefined
      for (const entry of stats.values()) {
        const stat: unknown = entry
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
      const stat: unknown = remoteCertificateId
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
        evidence.actualRemoteFingerprint = stat.fingerprint.toUpperCase()
        evidence.fingerprintMatches =
          evidence.actualRemoteFingerprint ===
          dtlsFingerprint(connection.remoteDescription.sdp)
      }
      if (!evidence.fingerprintMatches)
        localSession?.readonly('actual-certificate-mismatch')
      return evidence.fingerprintMatches
    })().catch(() => {
      localSession?.readonly('actual-certificate-unavailable')
      return false
    }))
  let ready: () => void = () => {}
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve
  })
  connection.onconnectionstatechange = () => {
    if (
      ['failed', 'disconnected', 'closed'].includes(connection.connectionState)
    )
      localSession?.readonly('transport-' + connection.connectionState)
  }
  connection.ondatachannel = (event) => {
    if (localChannel || event.channel.label !== 'synthetic-node-v1') {
      event.channel.close()
      localSession?.readonly('unexpected-channel')
      return
    }
    localChannel = event.channel
    channel = localChannel
    const active = localChannel
    active.onmessage = (event) => {
      void readyPromise.then(async () => {
        if (await checkCertificate()) await localSession?.receive(event.data)
      })
    }
    active.onclose = () => localSession?.readonly('channel-closed')
    active.onerror = () => localSession?.readonly('channel-error')
    active.onopen = () => {
      void readyPromise.then(async () => {
        if (await checkCertificate()) await localSession?.start()
      })
    }
    if (active.readyState === 'open')
      void readyPromise.then(async () => {
        if (await checkCertificate()) await localSession?.start()
      })
  }
  try {
    await connection.setRemoteDescription(input.offer)
    await connection.setLocalDescription(await connection.createAnswer())
    await gathered(connection)
    if (!connection.localDescription || !connection.remoteDescription)
      throw Error('Browser descriptions missing')
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
    localSession = new SyntheticSession({
      role: 'browser',
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
        const active = localChannel
        if (!active) throw Error('Browser channel missing')
        if (input.scenario === 'timeout') {
          if (frame.includes('"kind":"proof"')) blockedProof = frame
          return
        }
        if (frame.includes('"kind":"proof"')) {
          if (input.scenario === 'replay') {
            if (!oldProof) throw Error('Replay fixture missing')
            active.send(oldProof)
            return
          }
          if (input.scenario === 'valid') oldProof = frame
        }
        active.send(frame)
      },
      onReadonly: () => localChannel?.close(),
      deadlineMs: 8000,
    })
    session = localSession
    ready()
    return {
      type: 'answer',
      sdp: connection.localDescription.sdp,
    } satisfies RTCSessionDescriptionInit
  } catch (error) {
    ready()
    dispose()
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
    ...certificateEvidence,
    expectedRemoteFingerprint: peer?.remoteDescription
      ? dtlsFingerprint(peer.remoteDescription.sdp)
      : undefined,
  }
}
export function closePeer() {
  session?.readonly('transport-closed')
  peer?.close()
}
export function attemptAfterReadonly() {
  const before = session?.sentProofs.length ?? 0
  void session?.start()
  return { sentStatus: session?.sendStatus() ?? false, before }
}
export function dispose() {
  session?.dispose()
  if (channel) {
    channel.onmessage = null
    channel.onopen = null
    channel.onclose = null
    channel.onerror = null
    channel.close()
  }
  if (peer) {
    peer.onconnectionstatechange = null
    peer.ondatachannel = null
    peer.close()
  }
  session = undefined
  channel = undefined
  peer = undefined
}
