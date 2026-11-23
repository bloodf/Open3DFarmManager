<script setup lang="ts">
import type { ReplaySend } from '../../utils/replay-live.ts'
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import ReplayDialog from '../library/ReplayDialog.vue'
import type { JobHistoryItem } from '../../utils/job-history-view.ts'
import type { ReplayPrinter, ReplaySource } from '../../utils/replay-view.ts'

const props = defineProps<{
  job: JobHistoryItem
  /** Library version the job printed; undefined while it is unknown or gone. */
  source?: ReplaySource | undefined
  /** Looks the version up when the row is opened; used when `source` is not given. */
  loadSource?: () => Promise<ReplaySource>
  printers: readonly ReplayPrinter[]
  send: ReplaySend
}>()
const open = ref(false)
const loaded = ref<ReplaySource>()
const loading = ref(false)
const failed = ref(false)
const replaySource = computed(() => props.source ?? loaded.value)
const unavailable = computed(
  () => failed.value || (!props.source && !props.loadSource),
)

async function show() {
  if (loading.value) return
  if (!props.source && props.loadSource) {
    loading.value = true
    failed.value = false
    try {
      loaded.value = await props.loadSource()
    } catch {
      loaded.value = undefined
      failed.value = true
      return
    } finally {
      loading.value = false
    }
  }
  open.value = true
}
</script>

<template>
  <template v-if="job.librarySha256">
    <Button
      :disabled="loading || (!source && !loadSource)"
      :aria-label="`Imprimir de novo ${job.filename ?? 'este trabalho'}`"
      @click="show"
      >Imprimir de novo</Button
    >
    <p v-if="loading" role="status">Consultando a versão da biblioteca…</p>
    <p v-else-if="unavailable" role="note">
      A versão da biblioteca deste trabalho não está disponível.
    </p>
    <ReplayDialog
      v-if="replaySource"
      v-model="open"
      :source="replaySource"
      :printers="printers"
      :preferred-printer="props.job.printerKey"
      :preferred-plate="props.job.plate ?? 1"
      :send="send"
    />
  </template>
</template>
