<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CameraDisplay from '../../components/CameraDisplay.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import { useFarmView } from '../../composables/useFarmView.ts'

// The viewer is an integration link destination. Its ticket arrives in the fragment.
definePageMeta({ layout: false })

const target = ref<{ farmId: string; printerId: string } | null>(null)
const status = ref('Abrindo link da câmera…')
const view = useFarmView({
  cameraTarget: () => target.value?.printerId ?? null,
  requestedFarm: () => target.value?.farmId,
})
const stream = computed(() =>
  target.value && view.ready.value?.scope?.farmId === target.value.farmId
    ? view.cameraFor(target.value.printerId)
    : null,
)

onMounted(async () => {
  const ticket = window.location.hash.slice(1)
  if (!ticket) {
    status.value = 'Link da câmera indisponível.'
    return
  }
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname,
  )
  try {
    target.value = await $fetch('/api/camera-view', {
      method: 'POST',
      body: ticket,
      headers: { 'content-type': 'text/plain' },
      retry: 0,
    })
    await view.discover()
  } catch (error) {
    status.value =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 401
        ? 'Entre no OpenFarm e abra o link da câmera novamente.'
        : 'Link da câmera expirado ou câmera indisponível.'
  }
})
</script>

<template>
  <main id="conteudo" class="camera-page ops-screen">
    <div class="ops-heading">
      <p class="ops-wordmark" translate="no">Open3DFarmManager</p>
      <PageHeader title="Câmera da impressora" />
    </div>
    <div v-if="target" class="ops-panel">
      <CameraDisplay :stream="stream" />
    </div>
    <p v-else class="ops-panel" role="status">{{ status }}</p>
  </main>
</template>

<style scoped>
.camera-page {
  max-width: 64rem;
}
/* A single status line uses the whole panel width. */
.camera-page .ops-panel {
  max-width: none;
}
.camera-page :deep(.camera) {
  gap: var(--ops-space-3);
  margin: 0;
}
.camera-page :deep(.camera-frame) {
  max-height: min(36rem, 70vh);
  border-color: var(--ops-border);
  border-radius: var(--ops-radius-md);
}
.camera-page :deep(.camera-status) {
  color: var(--ops-muted);
}
.camera-page :deep(.camera[data-view='live'] .camera-status) {
  color: var(--ops-text);
  font-weight: 600;
}
/* Decorative marker beside the text that already names the state. */
.camera-page :deep(.camera[data-view='live'] .camera-status::before) {
  content: '';
  display: inline-block;
  inline-size: var(--ops-space-2);
  block-size: var(--ops-space-2);
  margin-inline-end: var(--ops-space-2);
  border-radius: 50%;
  background: var(--ops-printing);
}
.camera-page :deep(.camera[data-view='error'] .camera-status) {
  color: var(--ops-fault);
}
.camera-page :deep(.camera-toggle) {
  color: var(--ops-text);
  background: var(--ops-panel);
  border-color: var(--ops-muted);
  border-radius: var(--ops-radius-md);
  font-weight: 600;
  touch-action: manipulation;
}
.camera-page :deep(.camera-toggle:hover) {
  background: var(--ops-raised);
}
</style>
