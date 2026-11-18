// SPDX-License-Identifier: MIT
// Docker-free network fault proxy for the harness: TCP and UDP forwarders on
// loopback sharing one fault configuration that can change while traffic flows.
// Covers latency, jitter, loss, bandwidth cap, reset, blackhole and UDP-only
// block. It does not reproduce NAT: that needs network namespaces and stays in
// the opt-in Docker topology (OPENFARM_SIM=docker, see README.md).
import {
  CLEAN_FAULTS,
  mergeFaults,
  seededRandom,
  type NetFaultConfig,
} from './fault-config.ts'
import { startTcpForwarder, type TcpForwarder } from './tcp-forwarder.ts'
import { startUdpForwarder, type UdpForwarder } from './udp-forwarder.ts'

export type { NetFaultConfig } from './fault-config.ts'
export { CLEAN_FAULTS } from './fault-config.ts'

export type ForwardInput = {
  targetPort: number
  /** Loopback only. Defaults to 127.0.0.1. */
  targetHost?: string
  /** Defaults to an ephemeral port. */
  listenPort?: number
}

export type NetFaultProxy = {
  /** A copy of the faults currently applied. */
  faults(): NetFaultConfig
  /** Changes faults for traffic from now on; open connections are affected. */
  set(patch: Partial<NetFaultConfig>): NetFaultConfig
  /** Back to a clean link. */
  clear(): NetFaultConfig
  forwardTcp(input: ForwardInput): Promise<TcpForwarder>
  forwardUdp(input: ForwardInput): Promise<UdpForwarder>
  /** Resets every open TCP connection once; new connections still pass. */
  resetConnections(): void
  close(): Promise<void>
}

export function createNetFaultProxy(
  options: { faults?: Partial<NetFaultConfig>; seed?: number } = {},
): NetFaultProxy {
  let config = mergeFaults(CLEAN_FAULTS, options.faults ?? {})
  const random = seededRandom(options.seed ?? 0x0f4a17)
  const tcp = new Set<TcpForwarder>()
  const udp = new Set<UdpForwarder>()
  const read = () => config
  return {
    faults: () => ({ ...config }),
    set(patch) {
      config = mergeFaults(config, patch)
      for (const forwarder of tcp) forwarder.refresh()
      return { ...config }
    },
    clear() {
      return this.set({ ...CLEAN_FAULTS })
    },
    async forwardTcp(input) {
      const forwarder = await startTcpForwarder({
        ...input,
        config: read,
        random,
      })
      tcp.add(forwarder)
      return forwarder
    },
    async forwardUdp(input) {
      const forwarder = await startUdpForwarder({
        ...input,
        config: read,
        random,
      })
      udp.add(forwarder)
      return forwarder
    },
    resetConnections() {
      for (const forwarder of tcp) forwarder.resetConnections()
    },
    async close() {
      await Promise.all([
        ...[...tcp].map((forwarder) => forwarder.close()),
        ...[...udp].map((forwarder) => forwarder.close()),
      ])
      tcp.clear()
      udp.clear()
    },
  }
}
