<script setup lang="ts">
import { ref } from 'vue'
import Button from '../ui/Button.vue'
import ReplayDialog from '../library/ReplayDialog.vue'
import type { LibraryPrintArgs } from '../../../../../packages/farm-protocol/src/control-actions.ts'
import type { JobHistoryItem } from '../../utils/job-history-view.ts'
import type {
  ReplayPrinter,
  ReplayResult,
  ReplaySource,
} from '../../utils/replay-view.ts'

const props = defineProps<{
  job: JobHistoryItem
  /** Library version the job printed; undefined while it is unknown or gone. */
  source?: ReplaySource | undefined
  printers: readonly ReplayPrinter[]
  send: (printerKey: string, args: LibraryPrintArgs) => Promise<ReplayResult>
}>()
const open = ref(false)
</script>

<template>
  <template v-if="job.librarySha256">
    <Button
      :disabled="!source"
      :aria-label="`Imprimir de novo ${job.filename ?? 'este trabalho'}`"
      @click="open = true"
      >Imprimir de novo</Button
    >
    <p v-if="!source" role="note">
      A versão da biblioteca deste trabalho não está disponível.
    </p>
    <ReplayDialog
      v-if="source"
      v-model="open"
      :source="source"
      :printers="printers"
      :preferred-printer="props.job.printerKey"
      :preferred-plate="props.job.plate ?? 1"
      :send="send"
    />
  </template>
</template>
