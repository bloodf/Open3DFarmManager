<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  createCameraDisplaySession,
  type CameraDisplayState,
} from '../utils/camera-display.ts'

// Supply only a stream admitted by the browser-to-Connector flow. No URL input.
const props = defineProps<{ stream: MediaStream | null }>()
const video = ref<HTMLVideoElement | null>(null)
const state = ref<CameraDisplayState>('closed')

watch(
  [video, () => props.stream],
  ([element, stream], _previous, onCleanup) => {
    if (!element || !stream) {
      state.value = 'closed'
      return
    }
    const session = createCameraDisplaySession({
      changed: (next) => {
        state.value = next
      },
      detach() {
        element.pause()
        element.srcObject = null
      },
    })
    const ready = () => session.ready()
    const fail = () => session.fail()
    element.addEventListener('playing', ready)
    element.addEventListener('error', fail)
    onCleanup(() => {
      element.removeEventListener('playing', ready)
      element.removeEventListener('error', fail)
      session.close()
    })
    element.srcObject = stream
    try {
      void element.play().catch(fail)
    } catch {
      fail()
    }
  },
  // Revocation must detach before a queued playing event can publish ready.
  { flush: 'sync' },
)
</script>

<template>
  <section aria-label="Câmera da impressora" :aria-busy="state === 'loading'">
    <video
      ref="video"
      v-show="state === 'ready'"
      autoplay
      muted
      playsinline
      aria-label="Imagem ao vivo da impressora, sem áudio"
    />
    <p role="status" aria-live="polite">
      <template v-if="state === 'loading'">Carregando câmera…</template>
      <template v-else-if="state === 'error'">
        Não foi possível exibir a câmera. A visualização foi encerrada.
      </template>
      <template v-else-if="state === 'closed'">Câmera indisponível.</template>
      <template v-else>Câmera ao vivo.</template>
    </p>
  </section>
</template>

<style scoped>
video {
  display: block;
  width: 100%;
  max-height: 24rem;
  object-fit: contain;
}
</style>
