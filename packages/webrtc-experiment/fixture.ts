/** Synthetic-only local experiment. Never import into a printer driver. */
export type Scenario =
  | 'valid'
  | 'wrong-peer'
  | 'substitution'
  | 'replay'
  | 'timeout'
  | 'closed'
  | 'peer-closed'
type Role = 'browser' | 'connector'
type State = 'pending' | 'verified' | 'readonly'
const bytes = (text: string) => new TextEncoder().encode(text)
const hex = (data: ArrayBuffer) =>
  Array.from(new Uint8Array(data), (x) => x.toString(16).padStart(2, '0')).join(
    '',
  )
const nonce = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
const proofBytes = (transcript: string, role: Role) =>
  bytes(
    JSON.stringify(['Open3DFarmManager/synthetic-rtc/v1', role, transcript]),
  )
const fingerprint = (sdp: string | undefined) => {
  const matches = [
    ...(sdp ?? '').matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm),
  ]
  const values = new Set(matches.map((match) => match[1]?.toUpperCase()))
  const value = values.values().next().value
  if (
    values.size !== 1 ||
    !value ||
    !/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value)
  )
    throw Error('DTLS fingerprint missing')
  return value
}
async function gathered(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(Error('ICE deadline'))
    }, 3000)
    const changed = () => {
      if (peer.iceGatheringState === 'complete') {
        cleanup()
        resolve()
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', changed)
    }
    peer.addEventListener('icegatheringstatechange', changed)
    changed()
  })
}
let oldProof: string | undefined
const identity = () =>
  crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
const identities = Promise.all([identity(), identity(), identity()])

/** Keys are fresh, synthetic and pinned in memory, outside the channel under test. */
export async function runScenario(scenario: Scenario) {
  const [browserKey, connectorKey, strangerKey] = await identities
  if (!browserKey || !connectorKey || !strangerKey)
    throw Error('Missing identities')
  const browser = new RTCPeerConnection({ iceServers: [] })
  const connector = new RTCPeerConnection({ iceServers: [] })
  const peers = [browser, connector]
  const channels: RTCDataChannel[] = []
  const states: Record<Role, State> = {
    browser: 'pending',
    connector: 'pending',
  }
  const accepted: string[] = []
  const rejected: string[] = []
  const timers: ReturnType<typeof setTimeout>[] = []
  const readonly = () => {
    states.browser = 'readonly'
    states.connector = 'readonly'
  }
  const transcripts: Record<Role, string> = { browser: '', connector: '' }
  let ready: () => void = () => {}
  const transcriptReady = new Promise<void>((resolve) => {
    ready = resolve
  })
  let finished = false
  let complete: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    complete = resolve
  })
  const finish = () => {
    if (!finished) {
      finished = true
      complete()
    }
  }
  const deny = (reason: string) => {
    rejected.push(reason)
    readonly()
    finish()
  }
  const deadline = setTimeout(() => deny('deadline'), 8000)
  timers.push(deadline)
  async function attach(channel: RTCDataChannel, role: Role) {
    channels.push(channel)
    channel.onclose = () => {
      readonly()
      finish()
    }
    channel.onerror = () => deny('channel-error')
    channel.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2048)
          throw Error('frame')
        const frame: unknown = JSON.parse(event.data)
        if (!frame || typeof frame !== 'object' || !('kind' in frame))
          throw Error('frame')
        if (frame.kind === 'proof') {
          if (
            states[role] !== 'pending' ||
            !('signature' in frame) ||
            typeof frame.signature !== 'string' ||
            !/^[0-9a-f]{128}$/.test(frame.signature)
          )
            throw Error('proof')
          const remoteRole = role === 'browser' ? 'connector' : 'browser'
          const publicKey =
            role === 'browser' ? connectorKey.publicKey : browserKey.publicKey
          const signature = Uint8Array.from(
            frame.signature.match(/../g) ?? [],
            (x) => parseInt(x, 16),
          )
          const valid = await crypto.subtle.verify(
            'Ed25519',
            publicKey,
            signature,
            proofBytes(transcripts[role], remoteRole),
          )
          if (states[role] !== 'pending' || !valid)
            throw Error('identity-or-transcript')
          states[role] = 'verified'
          if (
            states.browser === 'verified' &&
            states.connector === 'verified'
          ) {
            if (scenario === 'closed') channel.close()
            else if (scenario === 'peer-closed') browser.close()
            else if (scenario === 'valid')
              channel.send(
                JSON.stringify({
                  kind: 'synthetic-status',
                  value: 'fixture-idle',
                }),
              )
          }
        } else if (
          frame.kind === 'synthetic-status' &&
          'value' in frame &&
          frame.value === 'fixture-idle' &&
          states[role] === 'verified'
        ) {
          accepted.push(frame.value)
          finish()
        } else throw Error('synthetic-only')
      } catch (error) {
        deny(error instanceof Error ? error.message : 'rejected')
      }
    }
    channel.onopen = async () => {
      try {
        await transcriptReady
        if (states[role] === 'readonly' || scenario === 'timeout') return
        const signingKey =
          role === 'browser'
            ? browserKey
            : scenario === 'wrong-peer'
              ? strangerKey
              : connectorKey
        const signedTranscript =
          scenario === 'substitution' && role === 'connector'
            ? transcripts[role].replace(
                fingerprint(browser.localDescription?.sdp),
                '00:'.repeat(31) + '00',
              )
            : transcripts[role]
        const signature = hex(
          await crypto.subtle.sign(
            'Ed25519',
            signingKey.privateKey,
            proofBytes(signedTranscript, role),
          ),
        )
        const proof = JSON.stringify({ kind: 'proof', signature })
        if (role === 'connector') {
          const previous = oldProof
          if (scenario === 'replay' && !previous)
            throw Error('Missing replay fixture')
          if (scenario === 'valid') oldProof = proof
          channel.send(scenario === 'replay' && previous ? previous : proof)
        } else channel.send(proof)
      } catch {
        deny('signing')
      }
    }
  }
  try {
    connector.ondatachannel = (event) => {
      void attach(event.channel, 'connector')
    }
    await attach(
      browser.createDataChannel('synthetic-status-v1', { ordered: true }),
      'browser',
    )
    for (const peer of peers)
      peer.onconnectionstatechange = () => {
        if (
          ['failed', 'disconnected', 'closed'].includes(peer.connectionState)
        ) {
          readonly()
          finish()
        }
      }
    await browser.setLocalDescription(await browser.createOffer())
    await gathered(browser)
    if (!browser.localDescription) throw Error('Missing offer')
    await connector.setRemoteDescription(browser.localDescription)
    await connector.setLocalDescription(await connector.createAnswer())
    await gathered(connector)
    if (!connector.localDescription) throw Error('Missing answer')
    await browser.setRemoteDescription(connector.localDescription)
    // Both roles, pinned synthetic identities, fresh nonces and actual SDP DTLS certificates.
    const session = nonce()
    const browserIdentity = hex(
      await crypto.subtle.exportKey('spki', browserKey.publicKey),
    )
    const connectorIdentity = hex(
      await crypto.subtle.exportKey('spki', connectorKey.publicKey),
    )
    const browserNonce = nonce()
    const connectorNonce = nonce()
    const encode = (browserFingerprint: string, connectorFingerprint: string) =>
      JSON.stringify([
        'synthetic-only-v1',
        session,
        ['browser', browserIdentity, browserNonce, browserFingerprint],
        ['connector', connectorIdentity, connectorNonce, connectorFingerprint],
      ])
    // Each peer independently derives its expected binding from its own SDP view.
    transcripts.browser = encode(
      fingerprint(browser.localDescription?.sdp),
      fingerprint(browser.remoteDescription?.sdp),
    )
    transcripts.connector = encode(
      fingerprint(connector.remoteDescription?.sdp),
      fingerprint(connector.localDescription?.sdp),
    )
    ready()
    await done
    clearTimeout(deadline)
    if (scenario === 'timeout') {
      // A correctly signed late proof crosses the real channel after the deadline.
      const channel = channels[0]
      if (!channel || channel.readyState !== 'open')
        throw Error('Missing late-proof channel')
      channel.send(
        JSON.stringify({
          kind: 'proof',
          signature: hex(
            await crypto.subtle.sign(
              'Ed25519',
              browserKey.privateKey,
              proofBytes(transcripts.browser, 'browser'),
            ),
          ),
        }),
      )
      channel.send(
        JSON.stringify({ kind: 'synthetic-status', value: 'fixture-idle' }),
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return {
      scenario,
      states: { ...states },
      accepted: [...accepted],
      rejected: [...rejected],
      fingerprints: [
        fingerprint(browser.localDescription?.sdp),
        fingerprint(connector.localDescription?.sdp),
      ],
      connection: peers.map((peer) => peer.connectionState),
      dtls: peers.map((peer) => peer.sctp?.transport.state),
      candidates: peers.map((peer) => {
        const pair =
          peer.sctp?.transport.iceTransport.getSelectedCandidatePair()
        return pair
          ? { local: pair.local.type, remote: pair.remote.type }
          : null
      }),
      iceServers: peers.map((peer) => peer.getConfiguration().iceServers),
      channelProtocol: channels.map((channel) => channel.label),
    }
  } finally {
    readonly()
    ready()
    timers.forEach(clearTimeout)
    channels.forEach((channel) => channel.close())
    peers.forEach((peer) => peer.close())
  }
}
