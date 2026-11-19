// SPDX-License-Identifier: MIT
// Stands in for composables/useReplayLive.ts in the page harness: the WebRTC
// session cannot run in-process, so the page reads its live printers from
// `window.__replayLive` and records what it sends there.
type Live = {
  info: Record<string, unknown>
  result: unknown
  sent: { printerKey: string; args: unknown }[]
}
export function useReplayLive() {
  const state = (window as unknown as { __replayLive: Live }).__replayLive
  return {
    liveFor: (printerKey: string) => state.info[printerKey],
    send: async (printerKey: string, args: unknown) => {
      state.sent.push({ printerKey, args })
      return state.result
    },
  }
}
