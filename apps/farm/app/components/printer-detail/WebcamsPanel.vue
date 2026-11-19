<script setup lang="ts">
import { computed, ref } from 'vue'
import type { z } from 'zod'
import type { PrinterDetailUpdate } from '../../../../../packages/farm-protocol/src/printer-detail.ts'
import CameraDisplay from '../CameraDisplay.vue'

type Webcam = NonNullable<
  z.infer<typeof PrinterDetailUpdate>['detail']['webcams']
>[number]
const props = defineProps<{
  webcams: readonly Webcam[]
  streamFor: (uid: string) => MediaStream | null
}>()
const selected = ref(0)
const webcam = computed(() => props.webcams[selected.value])
const stream = computed(() => {
  const camera = webcam.value
  return camera?.enabled && camera.uid ? props.streamFor(camera.uid) : null
})
const transform = computed(() => {
  const camera = webcam.value
  return camera
    ? `rotate(${camera.rotation}deg) scale(${camera.flipHorizontal ? -1 : 1}, ${camera.flipVertical ? -1 : 1})`
    : undefined
})
const display = ref<HTMLElement | null>(null)
const fullscreenError = ref(false)
async function fullscreen() {
  fullscreenError.value = false
  try {
    await display.value?.requestFullscreen()
  } catch {
    fullscreenError.value = true
  }
}
</script>

<template>
  <section aria-label="Câmeras">
    <h2>Câmeras</h2>
    <p v-if="!webcams.length" role="status">Nenhuma câmera cadastrada.</p>
    <template v-else>
      <label>
        Câmera
        <select v-model="selected">
          <option v-for="(item, index) in webcams" :key="index" :value="index">
            {{ item.name }}{{ item.enabled ? '' : ' (desativada)' }}
          </option>
        </select>
      </label>
      <div ref="display" class="webcam-display">
        <button v-if="stream" type="button" @click="fullscreen">
          Tela cheia
        </button>
        <p v-if="fullscreenError" role="status">
          Não foi possível abrir a tela cheia.
        </p>
        <CameraDisplay
          v-if="stream"
          :key="selected"
          :stream="stream"
          :style="{ '--webcam-transform': transform }"
        />
        <p v-else role="status">Imagem indisponível para esta câmera.</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.webcam-display :deep(video) {
  transform: var(--webcam-transform, none);
}
.webcam-display:fullscreen {
  background: Canvas;
  color: CanvasText;
}
.webcam-display:fullscreen :deep(video) {
  max-height: 85vh;
}
</style>
