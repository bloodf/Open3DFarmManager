<script setup lang="ts">
definePageMeta({ layout: false })
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import PrinterKiosk from '../components/farm/PrinterKiosk.vue'
import type { LastKnownState } from '../composables/useLastKnownStates-core.ts'
import {
  parseStatusSummary,
  statusSummaryPath,
} from '../utils/status-summary.ts'
import { themeScript, themeStyles } from '../utils/pre-hydration.ts'
import {
  KIOSK_PAGE_MS,
  KIOSK_POLL_MS,
  clampKioskPage,
  kioskCapacity,
  kioskPageCount,
  kioskRemPx,
} from '../utils/kiosk-wall.ts'

// This page has no layout, so it applies the saved theme itself.
useHead({
  script: [{ innerHTML: themeScript }],
  style: [{ innerHTML: themeStyles }],
})

// Read-only wall for a TV. It polls the farm status summary (works for any
// member session, no browser-device enrollment) and renders no control.
const route = useRoute()
const states = shallowRef<readonly LastKnownState[]>([])
const fetchedAt = ref<number | null>(null)
const failed = ref(false)
const problem = ref('')
const noFarm = ref(false)
const now = ref(0)
const page = ref(0)
const size = ref({ width: 1920, height: 1080 })
const perPage = computed(() =>
  kioskCapacity(size.value.width, size.value.height),
)
const fontPx = computed(() => kioskRemPx(size.value.width))

let farmId = ''
let controller: AbortController | undefined
let timers: ReturnType<typeof setInterval>[] = []
let lock: WakeLockSentinel | null = null

function status(cause: unknown) {
  return typeof cause === 'object' && cause !== null && 'statusCode' in cause
    ? cause.statusCode
    : undefined
}

async function poll() {
  controller?.abort()
  const run = (controller = new AbortController())
  try {
    if (!farmId) {
      const body = await $fetch<{ farms?: { farmId: string }[] }>(
        '/api/farms',
        {
          signal: run.signal,
          retry: 0,
          timeout: 10_000,
          cache: 'no-store',
        },
      )
      const farms = body.farms ?? []
      const wanted =
        typeof route.query.farm === 'string' ? route.query.farm : ''
      farmId =
        (farms.find((f) => f.farmId === wanted) ?? farms[0])?.farmId ?? ''
      if (!farmId) {
        noFarm.value = true
        return
      }
    }
    // `no-cache` revalidates with the route's ETag: an unchanged farm answers
    // 304 and the 5 s poll stays cheap.
    const parsed = parseStatusSummary(
      await $fetch<unknown>(statusSummaryPath(farmId), {
        signal: run.signal,
        retry: 0,
        timeout: 10_000,
        cache: 'no-cache',
      }),
    )
    if (run.signal.aborted) return
    if (!parsed.ok) throw new Error('invalid-response')
    states.value = parsed.summary.states
    // Move the wall clock with the fetch so the first age is never negative,
    // which would flash "Dados desatualizados" until the next tick.
    now.value = fetchedAt.value = Date.now()
    failed.value = false
    noFarm.value = false
    problem.value = ''
  } catch (cause) {
    if (run.signal.aborted) return
    // Keep the previous states on screen; the age keeps growing and flags them.
    failed.value = true
    problem.value =
      status(cause) === 401
        ? 'Sessão indisponível. Entre novamente em outro dispositivo.'
        : ''
  }
}

async function acquireWakeLock() {
  try {
    if (document.visibilityState !== 'visible' || lock) return
    const sentinel = (await navigator.wakeLock?.request('screen')) ?? null
    sentinel?.addEventListener('release', () => (lock = null))
    lock = sentinel
  } catch {
    // Wake Lock is optional: denied or unsupported just leaves the screen policy alone.
  }
}
const measure = () => {
  size.value = { width: window.innerWidth, height: window.innerHeight }
}
const onVisible = () => {
  if (document.visibilityState === 'visible') {
    void acquireWakeLock()
    void poll()
  }
}

onMounted(() => {
  now.value = Date.now()
  measure()
  void poll()
  void acquireWakeLock()
  timers = [
    setInterval(poll, KIOSK_POLL_MS),
    setInterval(() => (now.value = Date.now()), 1000),
    setInterval(() => {
      const count = kioskPageCount(states.value.length, perPage.value)
      page.value =
        count > 1
          ? (clampKioskPage(page.value, states.value.length, perPage.value) +
              1) %
            count
          : 0
    }, KIOSK_PAGE_MS),
  ]
  window.addEventListener('resize', measure)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  controller?.abort()
  timers.forEach(clearInterval)
  window.removeEventListener('resize', measure)
  document.removeEventListener('visibilitychange', onVisible)
  void lock?.release().catch(() => {})
})
</script>

<template>
  <main id="conteudo" class="kiosk-root" :style="{ fontSize: `${fontPx}px` }">
    <p
      v-if="problem && fetchedAt !== null"
      class="kiosk-root__problem"
      role="alert"
    >
      {{ problem }}
    </p>
    <PrinterKiosk
      :states="states"
      :now-wall-ms="now"
      :fetched-at="fetchedAt"
      :failed="failed"
      :no-farm="noFarm"
      :problem="problem"
      :page="page"
      :per-page="perPage"
    />
  </main>
</template>

<style>
/* Keep the full-screen wall layout while following the saved app theme. */
.kiosk-root {
  position: fixed;
  inset: 0;
  max-width: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  color: var(--color-text);
}
.kiosk-root > .kiosk {
  flex: 1;
  min-height: 0;
}
.kiosk-root__problem {
  margin: 0;
  max-width: none;
  padding: 0.5rem 1rem;
  border-block-end: 2px solid var(--state-error-color);
  background: var(--color-surface-raised);
  color: var(--state-error-color);
  font-weight: 700;
}
.kiosk-root .kiosk__warn,
.kiosk-root .kiosk__warn strong {
  color: var(--state-paused-color);
}
.kiosk-root .kiosk__head .kiosk__warn.stale {
  background: transparent;
  border-color: var(--state-paused-color);
}
.kiosk-root .kiosk__card,
.kiosk-root .ui-card {
  background: var(--color-surface-raised);
}
</style>
