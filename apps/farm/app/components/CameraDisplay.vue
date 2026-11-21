<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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

// One view per visible situation; the copy below is the single status message.
const view = computed(() => {
  if (props.stream && !started.value) return 'paused'
  if (state.value === 'loading') return 'loading'
  if (state.value === 'error') return 'error'
  if (state.value === 'closed') return 'unavailable'
  return 'live'
})
</script>

<template>
  <section
    class="camera"
    :aria-label="
      printerName
        ? `Câmera da impressora ${printerName}`
        : 'Câmera da impressora'
    "
    :aria-busy="state === 'loading'"
    :data-view="view"
  >
    <div class="camera-frame">
      <video
        ref="video"
        v-show="state === 'ready'"
        class="camera-video"
        muted
        playsinline
        disablepictureinpicture
        :aria-label="
          printerName
            ? `Imagem ao vivo da impressora ${printerName}, sem áudio`
            : 'Imagem ao vivo da impressora, sem áudio'
        "
      />
      <div
        v-if="state !== 'ready'"
        class="camera-placeholder"
        :class="{ 'camera-pulse': view === 'loading' }"
        aria-hidden="true"
      >
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          focusable="false"
        >
          <path d="M3 7h4l2-3h6l2 3h4v12H3z" />
          <circle cx="12" cy="13" r="3.5" />
          <path v-if="view !== 'loading'" d="M3 3l18 18" />
        </svg>
      </div>
    </div>
    <div class="camera-bar">
      <p class="camera-status" role="status" aria-live="polite">
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
      <button
        v-if="stream"
        class="camera-toggle"
        type="button"
        @click="started = !started"
      >
        {{ started ? 'Parar imagem ao vivo' : 'Mostrar imagem ao vivo' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* Self-contained: system colours are the fallback when tokens are absent. */
.camera {
  display: grid;
  gap: var(--space-3, 0.75rem);
  min-width: 0;
  margin-block: var(--space-4, 1rem);
}
.camera-frame {
  position: relative;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  max-height: 24rem;
  inline-size: 100%;
  border: 1px solid var(--color-border, GrayText);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface, Canvas);
}
.camera[data-view='live'] .camera-frame {
  background: black;
}
.camera-video {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  object-fit: contain;
}
.camera-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--color-text-muted, GrayText);
}
.camera[data-view='error'] .camera-placeholder {
  color: var(--printer-error, CanvasText);
}
@media (prefers-reduced-motion: no-preference) {
  .camera-pulse {
    animation: camera-pulse 1.6s ease-in-out infinite;
  }
}
@keyframes camera-pulse {
  50% {
    opacity: 0.4;
  }
}
.camera-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
}
.camera-status {
  flex: 1 1 14rem;
  min-width: 0;
  margin: 0;
  max-width: none;
  font-size: var(--font-size-sm, 0.875rem);
  line-height: var(--line-height-normal, 1.6);
  color: var(--color-text-muted, CanvasText);
  overflow-wrap: anywhere;
}
.camera[data-view='error'] .camera-status {
  color: var(--printer-error, CanvasText);
  font-weight: var(--font-weight-semibold, 600);
}
.camera-toggle {
  min-height: 2.75rem;
  min-width: 2.75rem;
  max-width: 100%;
  padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
  border: 1px solid var(--color-accent, ButtonText);
  border-radius: var(--radius-sm, 0.25rem);
  background: var(--color-surface-raised, ButtonFace);
  color: var(--color-accent, ButtonText);
  font: inherit;
  cursor: pointer;
}
.camera-toggle:focus-visible {
  outline: var(--focus-ring-width, 3px) solid
    var(--color-focus-ring, currentColor);
  outline-offset: 3px;
}
</style>
