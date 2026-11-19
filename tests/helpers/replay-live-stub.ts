// SPDX-License-Identifier: MIT
// Stands in for composables/useReplayLive.ts in the page harness: the WebRTC
// session cannot run in-process, so the page reads its live printers from
// `window.__replayLive` and records what it sends there.
type Live = {
  info: Record<string, unknown>
  /** Optional: live info per farm, for accounts with more than one farm. */
  infoByFarm?: Record<string, Record<string, unknown>>
  result: unknown
  sent: { printerKey: string; args: unknown; farmId?: string }[]
}
type FarmSource = string | { value: string } | (() => string) | undefined
const farmOf = (source: FarmSource) =>
  typeof source === 'function'
    ? source()
    : typeof source === 'object'
      ? source.value
      : (source ?? '')
export function useReplayLive(farmId?: FarmSource) {
  const state = (window as unknown as { __replayLive: Live }).__replayLive
  const info = () =>
    state.infoByFarm ? (state.infoByFarm[farmOf(farmId)] ?? {}) : state.info
  return {
    liveFor: (printerKey: string) => info()[printerKey],
    send: async (printerKey: string, args: unknown) => {
      state.sent.push({
        printerKey,
        args,
        ...(state.infoByFarm ? { farmId: farmOf(farmId) } : {}),
      })
      return state.result
    },
  }
}
