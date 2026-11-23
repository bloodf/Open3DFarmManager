// A V2Signer whose private key is the persisted, nonextractable Chromium
// device key. Every signature is produced inside the page.
import type { Page } from '@playwright/test'
import type { V2Signer } from './command-v2-dispatch.ts'

type Slot = { farmId: string; userId: string }

/** Imports the bundled protocol into the page and loads (or creates) the device key. */
export async function chromiumSigner(
  page: Page,
  source: string,
  slot: Slot,
): Promise<V2Signer & { exportDenied: boolean }> {
  const loaded = await page.evaluate(
    async ({ source, slot }) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      )
      try {
        const api = await import(url)
        const pair = await api.loadOrCreateDeviceKey(slot)
        ;(globalThis as Record<string, unknown>).__v2Signer = { api, pair }
        let exportDenied = false
        try {
          await crypto.subtle.exportKey('jwk', pair.privateKey)
        } catch {
          exportDenied = true
        }
        const { kty, crv, x, y } = await crypto.subtle.exportKey(
          'jwk',
          pair.publicKey,
        )
        return { publicJwk: { kty, crv, x, y }, exportDenied }
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    { source, slot },
  )
  const sign = <T>(kind: string, input: unknown) =>
    page.evaluate(
      async ({ kind, input }) => {
        const { api, pair } = (globalThis as Record<string, any>).__v2Signer
        if (kind === 'command') return api.signCommandV2(input, pair.privateKey)
        if (kind === 'admission')
          return api.signPauseAdmissionProof(input, pair.privateKey)
        return api.signControlSessionProof(input, 'browser', pair.privateKey)
      },
      { kind, input },
    ) as Promise<T>
  return {
    publicJwk: loaded.publicJwk as V2Signer['publicJwk'],
    exportDenied: loaded.exportDenied,
    signCommand: (input) => sign('command', input),
    signAdmissionProof: (challenge) => sign('admission', challenge),
    signControlProof: (binding) => sign('control', binding),
  }
}
