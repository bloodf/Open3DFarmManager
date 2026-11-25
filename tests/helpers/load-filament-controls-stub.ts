// SPDX-License-Identifier: AGPL-3.0-or-later
// Stands in for components/farm/useFarmControls.ts in the page harness: it
// records what the page asks for and opens the page's own confirmation dialog.
// Nothing is signed or sent.
import { nextTick, ref, shallowRef } from 'vue'

declare const window: Window & {
  __controls?: { action: string; args: Record<string, unknown> }[]
}

export function useFarmControls(
  _view: unknown,
  dialog: { value: { show(): void; close(): void } },
) {
  const pauseTarget = shallowRef<{
    printerKey: string
    action: string
    args: Record<string, unknown>
  } | null>(null)
  return {
    pauseEnabled: ref(true),
    pauseTarget,
    pauseState: shallowRef({ kind: 'connecting' }),
    pauseRemaining: ref(0),
    pauseStatus: ref(''),
    commandInFlight: ref(false),
    async openControl(
      row: { assignment: { printerKey: string } },
      action: string,
      _event: Event,
      args: Record<string, unknown>,
    ) {
      ;(window.__controls ??= []).push({ action, args })
      pauseTarget.value = {
        printerKey: row.assignment.printerKey,
        action,
        args,
      }
      await nextTick()
      dialog.value.show()
    },
    connectFiles() {},
    confirmControl() {},
    closePause() {
      dialog.value.close()
      pauseTarget.value = null
    },
  }
}
