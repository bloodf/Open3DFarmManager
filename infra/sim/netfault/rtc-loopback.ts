// SPDX-License-Identifier: MIT
// In-process WebRTC data-channel pair whose UDP traffic crosses the fault proxy.
// The signalling mock below rewrites both peers' host candidates to proxy ports,
// so ICE, DTLS and SCTP packets all pass the faults in both directions. Peers use
// the Connector's ICE options (no STUN/TURN, no ICE-TCP, loopback bind).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { NetFaultProxy } from './fault-proxy.ts'
import { hostCandidatePorts, rewriteHostCandidates } from './sdp-rewrite.ts'
import type { UdpForwarder } from './udp-forwarder.ts'

const connectorManifest = fileURLToPath(
  new URL('../../../packages/connector/package.json', import.meta.url),
)

type Description = { sdp: string; type: string }
type Peer = {
  gatheringState(): string
  localDescription(): Description | null
  onGatheringStateChange(handler: (state: string) => void): void
  setLocalDescription(type?: string): void
  setRemoteDescription(sdp: string, type: string): void
  createDataChannel(label: string): Channel
  onDataChannel(handler: (channel: Channel) => void): void
  iceState(): string
  close(): void
}
type Channel = {
  onOpen(handler: () => void): void
  onMessage(handler: (message: string | Buffer) => void): void
  sendMessage(message: string): boolean
  isOpen(): boolean
}
type Datachannel = {
  PeerConnection: new (name: string, config: object) => Peer
  cleanup(): void
}

export function loadDatachannel(): Datachannel {
  const module = createRequire(connectorManifest)('node-datachannel') as {
    default?: Datachannel
  } & Datachannel
  return module.default ?? module
}

function gathered(pc: Peer): Promise<Description> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('gathering timeout')),
      10000,
    )
    const poll = setInterval(check, 50)
    function check() {
      const description = pc.localDescription()
      if (pc.gatheringState() === 'complete' && description) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve(description)
      }
    }
    pc.onGatheringStateChange(check)
  })
}

export type LoopbackChannel = {
  /** Sends one message and resolves true when its echo returns within timeoutMs. */
  echo(message: string, timeoutMs: number): Promise<boolean>
  isOpen(): boolean
  iceState(): string
  /** Resolves true once the channel opens, false after timeoutMs. */
  opened: Promise<boolean>
  close(): Promise<void>
}

/**
 * Starts an offer/answer exchange through `proxy`. Faults already set on the
 * proxy apply from the first STUN check. The echo peer returns every message.
 */
export async function openProxiedChannel(input: {
  proxy: NetFaultProxy
  openTimeoutMs: number
}): Promise<LoopbackChannel> {
  const { PeerConnection } = loadDatachannel()
  const forwarders: UdpForwarder[] = []
  const options = {
    iceServers: [],
    enableIceTcp: false,
    bindAddress: '127.0.0.1',
  }
  const offerer = new PeerConnection('sim-offerer', options)
  const answerer = new PeerConnection('sim-answerer', options)
  const waiters = new Map<string, (echoed: true) => void>()
  const channel = offerer.createDataChannel('sim')
  channel.onMessage((message) => {
    const key = String(message)
    waiters.get(key)?.(true)
    waiters.delete(key)
  })
  answerer.onDataChannel((remote) =>
    remote.onMessage((message) => remote.sendMessage(String(message))),
  )
  const through = async (sdp: string) => {
    const map = new Map<number, number>()
    for (const port of hostCandidatePorts(sdp)) {
      const forwarder = await input.proxy.forwardUdp({ targetPort: port })
      forwarders.push(forwarder)
      map.set(port, forwarder.port)
    }
    return rewriteHostCandidates(sdp, map).sdp
  }
  const offer = gathered(offerer)
  offerer.setLocalDescription()
  const offered = await offer
  const answer = gathered(answerer)
  answerer.setRemoteDescription(await through(offered.sdp), offered.type)
  const answered = await answer
  const opened = new Promise<boolean>((resolve) => {
    channel.onOpen(() => resolve(true))
    setTimeout(() => resolve(channel.isOpen()), input.openTimeoutMs).unref()
  })
  offerer.setRemoteDescription(await through(answered.sdp), answered.type)
  return {
    opened,
    isOpen: () => channel.isOpen(),
    iceState: () => offerer.iceState(),
    echo(message, timeoutMs) {
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(message)
          resolve(false)
        }, timeoutMs)
        waiters.set(message, () => {
          clearTimeout(timer)
          resolve(true)
        })
        try {
          channel.sendMessage(message)
        } catch {
          clearTimeout(timer)
          waiters.delete(message)
          resolve(false)
        }
      })
    },
    async close() {
      offerer.close()
      answerer.close()
      await Promise.all(forwarders.map((forwarder) => forwarder.close()))
    },
  }
}
