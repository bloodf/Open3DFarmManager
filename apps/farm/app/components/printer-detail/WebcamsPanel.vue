<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { z } from 'zod'
import type { PrinterDetailStreamUpdate } from '../../../../../packages/farm-protocol/src/printer-detail.ts'
import Button from '../ui/Button.vue'
import Field from '../ui/Field.vue'
import CameraDisplay from '../CameraDisplay.vue'

type Webcam = NonNullable<
  z.infer<typeof PrinterDetailStreamUpdate>['detail']['webcams']
>[number]
const props = defineProps<{
  webcams: readonly Webcam[]
  streamFor: (uid: string) => MediaStream | null
}>()
const headingId = useId()
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
  <section class="webcams" :aria-labelledby="headingId">
    <h2 :id="headingId">Câmeras</h2>
    <p v-if="!webcams.length" class="webcams-empty" role="status">
      Nenhuma câmera cadastrada.
    </p>
    <template v-else>
      <Field v-slot="{ control }" label="Câmera">
        <select v-bind="control" v-model="selected" class="webcams-select">
          <option v-for="(item, index) in webcams" :key="index" :value="index">
            {{ item.name }}{{ item.enabled ? '' : ' (desativada)' }}
          </option>
        </select>
      </Field>
      <div ref="display" class="webcam-display">
        <div v-if="stream" class="webcam-tools">
          <Button type="button" @click="fullscreen">Tela cheia</Button>
        </div>
        <p v-if="fullscreenError" class="webcams-error" role="status">
          Não foi possível abrir a tela cheia.
        </p>
        <CameraDisplay
          v-if="stream"
          :key="selected"
          :stream="stream"
          :style="{ '--webcam-transform': transform }"
        />
        <div v-else class="webcams-empty">
          <p role="status">Imagem indisponível para esta câmera.</p>
          <p v-if="webcam && !webcam.enabled" class="webcams-hint">
            Esta câmera está desativada.
          </p>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.webcams {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
  margin-block: var(--space-5);
}
.webcams h2 {
  margin: 0;
  font-size: var(--font-size-lg);
}
.webcams p {
  margin: 0;
  max-width: none;
}
.webcams-select {
  min-height: 2.75rem;
  inline-size: 100%;
  max-inline-size: 32rem;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
}
.webcams-select:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
.webcam-display {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.webcam-display :deep(.camera) {
  margin-block: 0;
}
.webcam-tools {
  display: flex;
  justify-content: flex-end;
}
.webcams-empty {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-5) var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  text-align: center;
  justify-items: center;
}
.webcams-hint {
  font-size: var(--font-size-sm);
}
.webcams-error {
  color: var(--printer-error);
}
.webcam-display :deep(video) {
  transform: var(--webcam-transform, none);
}
.webcam-display:fullscreen {
  background: Canvas;
  color: CanvasText;
  align-content: center;
  overflow: auto;
}
.webcam-display:fullscreen :deep(video) {
  max-height: 85vh;
}
</style>
