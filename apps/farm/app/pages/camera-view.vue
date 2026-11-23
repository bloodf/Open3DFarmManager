<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import CameraDisplay from '../components/CameraDisplay.vue'
import { useFarmView } from '../composables/useFarmView.ts'

const target = ref<{ farmId: string; printerId: string } | null>(null)
const status = ref('Abrindo link da câmera…')
const view = useFarmView(undefined, () => target.value?.printerId ?? null)
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

watch([target, view.ready], ([camera, ready]) => {
  if (
    camera &&
    ready &&
    ready.scope?.farmId !== camera.farmId &&
    ready.farms.some(({ farmId }) => farmId === camera.farmId)
  )
    void view.selectFarm(camera.farmId)
})
</script>

<template>
  <section>
    <h1>Câmera da impressora</h1>
    <CameraDisplay v-if="target" :stream="stream" />
    <p v-else role="status">{{ status }}</p>
  </section>
</template>
