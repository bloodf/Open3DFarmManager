// SPDX-License-Identifier: MIT
// Test-only WebRTC reachability probe for the network fault harness.
// Uses the Connector's PeerConnection options (no STUN/TURN, no ICE-TCP,
// fingerprint verification on); only the bind address varies.
//   PROBE_ROLE=answer  "browser" side: HTTP offer endpoint, echoes data.
//   PROBE_ROLE=offer   "Connector" side: posts an offer, measures the channel.
// Prints one JSON result line. Never contacts anything but PROBE_PEER.
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const env = process.env
const role = env.PROBE_ROLE
const bind = env.PROBE_BIND ?? 'any' // 'loopback' = Connector policy, 'any' = all interfaces
const iceTimeoutMs = Number(env.PROBE_ICE_TIMEOUT_MS ?? 20000)
const pings = Number(env.PROBE_PINGS ?? 40)
if (!['offer', 'answer'].includes(role) || !['any', 'loopback'].includes(bind))
  throw new Error(
    'PROBE_ROLE offer|answer and PROBE_BIND any|loopback required',
  )

const require = createRequire('/opt/ndc/package.json')
const { PeerConnection, cleanup } = (
  await import(require.resolve('node-datachannel'))
).default

function peer(name) {
  return new PeerConnection(name, {
    iceServers: [],
    enableIceTcp: false,
    disableFingerprintVerification: false,
    ...(bind === 'loopback' ? { bindAddress: '127.0.0.1' } : {}),
  })
}
// Non-trickle: wait for complete gathering, then hand over the full description.
function gathered(pc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('gathering timeout')),
      10000,
    )
    const check = () => {
      if (pc.gatheringState() === 'complete' && pc.localDescription()) {
        clearTimeout(timer)
        resolve(pc.localDescription())
        return true
      }
      return false
    }
    pc.onGatheringStateChange(() => check())
    // Auto-negotiation may finish gathering before this handler is attached.
    const poll = setInterval(() => check() && clearInterval(poll), 100)
  })
}
const candidates = (sdp) =>
  [...sdp.matchAll(/a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/g)].map(
    (m) => `${m[4]} ${m[1].toLowerCase()} ${m[2]}`,
  )
const done = (result) => {
  console.log(JSON.stringify({ role, bind, ...result }))
  cleanup()
  process.exit(0)
}

if (role === 'answer') {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) request.destroy()
    })
    request.on('end', async () => {
      try {
        const offer = JSON.parse(body)
        const pc = peer('probe-browser')
        pc.onDataChannel((channel) => {
          const pair = pc.getSelectedCandidatePair()
          // The remote address seen here is the NAT-mapped source, if any.
          console.log(
            JSON.stringify({
              role,
              event: 'channel',
              remote: pair && `${pair.remote.type} ${pair.remote.address}`,
            }),
          )
          channel.onMessage((message) => channel.sendMessage(String(message)))
        })
        const answer = gathered(pc)
        pc.setRemoteDescription(offer.sdp, offer.type)
        const local = await answer
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(local))
        console.log(
          JSON.stringify({
            role,
            event: 'answered',
            remoteCandidates: candidates(offer.sdp),
            localCandidates: candidates(local.sdp),
          }),
        )
      } catch (error) {
        response.writeHead(400)
        response.end()
        console.log(
          JSON.stringify({ role, event: 'error', error: String(error) }),
        )
      }
    })
  })
  server.listen(8000, '0.0.0.0')
} else {
  const started = performance.now()
  const pc = peer('probe-connector')
  const channel = pc.createDataChannel('probe')
  const offer = gathered(pc)
  pc.setLocalDescription()
  const local = await offer
  let answer
  try {
    const response = await fetch(`http://${env.PROBE_PEER}:8000/offer`, {
      method: 'POST',
      body: JSON.stringify(local),
      signal: AbortSignal.timeout(10000),
    })
    answer = await response.json()
  } catch (error) {
    done({ signalling: 'failed', error: String(error), rtc: 'not-attempted' })
  }
  const opened = new Promise((resolve) => {
    channel.onOpen(() => resolve(true))
    setTimeout(() => resolve(false), iceTimeoutMs)
  })
  pc.setRemoteDescription(answer.sdp, answer.type)
  const open = await opened
  const base = {
    signalling: 'ok',
    localCandidates: candidates(local.sdp),
    remoteCandidates: candidates(answer.sdp),
  }
  if (!open)
    done({
      ...base,
      rtc: 'failed',
      iceState: pc.iceState(),
      elapsedMs: Math.round(performance.now() - started),
    })
  const openMs = Math.round(performance.now() - started)
  const rtts = []
  channel.onMessage((message) => rtts.push(performance.now() - Number(message)))
  for (let i = 0; i < pings; i++) {
    channel.sendMessage(String(performance.now()))
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
  rtts.sort((a, b) => a - b)
  const pair = pc.getSelectedCandidatePair()
  done({
    ...base,
    rtc: 'open',
    openMs,
    sent: pings,
    echoed: rtts.length,
    rttMedianMs: rtts.length ? Math.round(rtts[rtts.length >> 1]) : null,
    selectedPair: pair && {
      local: `${pair.local.type} ${pair.local.address}`,
      remote: `${pair.remote.type} ${pair.remote.address}`,
    },
  })
}
