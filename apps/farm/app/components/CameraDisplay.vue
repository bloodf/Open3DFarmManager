<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import {
  createCameraDisplaySession,
  type CameraDisplayState,
} from '../utils/camera-display.ts'

// Supply only a stream admitted by the browser-to-Connector flow. No URL input.
const props = defineProps<{
  stream: MediaStream | null
  printerName?: string
}>()
const video = ref<HTMLVideoElement | null>(null)
const state = ref<CameraDisplayState>('closed')
// Live video is moving content: anyone can stop it; with reduced motion it
// starts only on request.
const reducedMotion = ref(false)
const started = ref(true)
onMounted(() => {
  reducedMotion.value =
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  started.value = !reducedMotion.value
})

watch(
  [video, () => props.stream, started],
  ([element, stream, start], _previous, onCleanup) => {
    if (!element || !stream || !start) {
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
  <section
    :aria-label="
      printerName
        ? `Câmera da impressora ${printerName}`
        : 'Câmera da impressora'
    "
    :aria-busy="state === 'loading'"
  >
    <video
      ref="video"
      v-show="state === 'ready'"
      muted
      playsinline
      disablepictureinpicture
      :aria-label="
        printerName
          ? `Imagem ao vivo da impressora ${printerName}, sem áudio`
          : 'Imagem ao vivo da impressora, sem áudio'
      "
    />
    <p role="status" aria-live="polite">
      <template v-if="stream && !started && reducedMotion">
        Câmera disponível. A imagem não inicia sozinha porque o movimento
        reduzido está ativado.
      </template>
      <template v-else-if="stream && !started">
        Imagem ao vivo parada.
      </template>
      <template v-else-if="state === 'loading'">Carregando câmera…</template>
      <template v-else-if="state === 'error'">
        Não foi possível exibir a câmera. A visualização foi encerrada.
      </template>
      <template v-else-if="state === 'closed'">Câmera indisponível.</template>
      <template v-else>Câmera ao vivo.</template>
    </p>
    <!-- WCAG 2.2.2: moving content can always be stopped and shown again. -->
    <button v-if="stream" type="button" @click="started = !started">
      {{ started ? 'Parar imagem ao vivo' : 'Mostrar imagem ao vivo' }}
    </button>
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
