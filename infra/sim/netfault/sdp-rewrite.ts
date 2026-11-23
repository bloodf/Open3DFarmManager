// SPDX-License-Identifier: MIT
// Signalling-side helper: rewrite host ICE candidates in an SDP so a peer
// connects to a fault-proxy UDP port instead of the real peer port. Used by the
// signalling mock so data-channel traffic crosses the proxy in both directions.

const CANDIDATE =
  /^(a=candidate:\S+ \d+ (?:udp|UDP) \d+ )(\S+) (\d+)( typ host.*)$/

export type CandidateMap = ReadonlyMap<number, number>

/**
 * Replaces the port of every UDP host candidate found in `ports` with its
 * mapped proxy port and the address with 127.0.0.1. Candidates that are not in
 * the map are removed, so no unproxied path can win the ICE race. Returns the
 * new SDP and the real ports that were rewritten.
 */
export function rewriteHostCandidates(sdp: string, ports: CandidateMap) {
  const rewritten: number[] = []
  const lines = sdp.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) {
      out.push(line)
      continue
    }
    const match = CANDIDATE.exec(line)
    const proxyPort = match && ports.get(Number(match[3]))
    if (!match || proxyPort === undefined) continue
    rewritten.push(Number(match[3]))
    out.push(`${match[1]}127.0.0.1 ${proxyPort}${match[4]}`)
  }
  return { sdp: out.join('\r\n'), rewritten }
}

/** Real UDP ports of the host candidates in an SDP. */
export function hostCandidatePorts(sdp: string): number[] {
  const ports = new Set<number>()
  for (const line of sdp.split(/\r?\n/)) {
    const match = CANDIDATE.exec(line)
    if (match) ports.add(Number(match[3]))
  }
  return [...ports]
}
