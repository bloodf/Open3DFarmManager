<script setup lang="ts">
import type {
  ControlAction,
  ExtendedControlAction,
} from '../../../../../packages/farm-protocol/src/control-actions.ts'
import {
  actionButtonConfirmationLabel,
  actionDialogDescription,
  actionDialogTitle,
} from '../../utils/farm-control.ts'
import { extendedLabel } from '../../utils/farm-control-extended.ts'
import type { FarmPauseControlState } from '../../utils/webrtc/farm-pause-control.ts'

defineProps<{
  pauseTarget: {
    assignmentId: string
    printerKey: string
    action: ExtendedControlAction
    args: Record<string, unknown>
  } | null
  pauseState: FarmPauseControlState
  pauseRemaining: number
  pauseStatus: string
  confirmControl: () => void
  closePause: () => void
  cancelPause: (event: Event) => void
}>()

// Same element refs the farm page and the controls fixture bind to.
const pauseDialog = defineModel<HTMLDialogElement | null>('pauseDialog', {
  default: null,
})
const pauseCancel = defineModel<HTMLButtonElement | null>('pauseCancel', {
  default: null,
})
</script>

<template>
  <dialog
    ref="pauseDialog"
    aria-labelledby="pause-dialog-title"
    aria-describedby="pause-dialog-description"
    @cancel="cancelPause"
  >
    <template v-if="pauseTarget">
      <h2 id="pause-dialog-title">
        {{
          ['pause', 'resume', 'cancel'].includes(pauseTarget.action)
            ? actionDialogTitle(
                pauseTarget.action as ControlAction,
                pauseTarget.printerKey,
              )
            : `${extendedLabel(pauseTarget.action)}${pauseTarget.action === 'run_macro' ? ` ${pauseTarget.args.name}` : ''} — ${pauseTarget.printerKey}`
        }}
      </h2>
      <p id="pause-dialog-description">
        {{
          ['pause', 'resume', 'cancel'].includes(pauseTarget.action)
            ? actionDialogDescription(
                pauseTarget.action as ControlAction,
                pauseTarget.printerKey,
              )
            : 'Confirme o comando para esta impressora. Ele será enviado diretamente ao Connector e não será repetido automaticamente.'
        }}
      </p>
      <p role="status" aria-live="polite">{{ pauseStatus }}</p>
      <div class="actions">
        <button
          type="button"
          :disabled="pauseState.kind !== 'ready' || pauseRemaining <= 0"
          @click="confirmControl"
        >
          {{
            ['pause', 'resume', 'cancel'].includes(pauseTarget.action)
              ? actionButtonConfirmationLabel(
                  pauseTarget.action as ControlAction,
                )
              : 'Confirmar comando'
          }}
        </button>
        <button
          ref="pauseCancel"
          type="button"
          :disabled="pauseState.kind === 'sending'"
          @click="closePause"
        >
          {{
            pauseState.kind === 'settled' || pauseState.kind === 'failed'
              ? 'Fechar'
              : 'Cancelar'
          }}
        </button>
      </div>
    </template>
  </dialog>
</template>
