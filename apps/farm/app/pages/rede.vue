<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FarmMap from '../components/network/FarmMap.vue'
import FarmScopeSelector from '../components/farm/FarmScopeSelector.vue'
import { useFarmView } from '../composables/useFarmView.ts'
import {
  buildEntries,
  printerOverlayKey,
  type NetworkData,
} from '../utils/network-map.ts'

const REFRESH_MS = 30_000
const view = useFarmView()
const { state, ready, now, discover, selectFarm } = view

const data = ref<NetworkData | null>(null)
const readAt = ref<number | null>(null)
const failure = ref('')
const loading = ref(false)
const heading = ref<HTMLElement | null>(null)
let controller: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined

const farmId = computed(() => ready.value?.scope?.farmId ?? '')

async function load() {
  const id = farmId.value
  controller?.abort()
  if (!id) {
    data.value = null
    return
  }
  controller = new AbortController()
  const { signal } = controller
  loading.value = true
  try {
    const result = await $fetch<NetworkData>(
      `/api/farms/${encodeURIComponent(id)}/network`,
      { signal, retry: 0, timeout: 10_000, cache: 'no-store' },
    )
    if (signal.aborted) return
    data.value = result
    readAt.value = Date.now()
    failure.value = ''
  } catch (error) {
    if (signal.aborted) return
    // Keep the last server data on screen; its age keeps growing.
    failure.value =
      (error as { status?: number }).status === 401
        ? 'Entre novamente para consultar a rede.'
        : 'Não foi possível atualizar a rede da farm. Tente novamente.'
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
watch(farmId, () => {
  data.value = null
  readAt.value = null
  void load()
})
onMounted(() => {
  heading.value?.focus()
  timer = setInterval(() => void load(), REFRESH_MS)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  controller?.abort()
})

const liveAgents = computed(
  () =>
    new Set(
      (ready.value?.rows ?? [])
        .filter((row) => row.connection === 'authenticated')
        .map((row) => row.assignment.agentId),
    ),
)
const livePrinters = computed(
  () =>
    new Map(
      (ready.value?.rows ?? []).flatMap((row) =>
        row.connection === 'authenticated' &&
        row.observation &&
        !row.observation.historical
          ? [
              [
                printerOverlayKey(
                  row.assignment.agentId,
                  row.assignment.printerKey,
                ),
                {
                  online: row.observation.state.state !== 'offline',
                  at: row.observation.received.wall,
                },
              ] as const,
            ]
          : [],
      ),
    ),
)
const entries = computed(() =>
  data.value
    ? buildEntries(data.value, {
        agents: liveAgents.value,
        printers: livePrinters.value,
        now: now.value.wall || Date.now(),
      })
    : [],
)
</script>

<template>
  <main id="conteudo">
    <h1 ref="heading" tabindex="-1">Rede da farm</h1>
    <p v-if="state.kind === 'loading'" role="status" aria-busy="true">
      Carregando suas farms…
    </p>
    <section
      v-else-if="state.kind === 'sign-in-required'"
      aria-label="Acesso à farm"
    >
      <p>Entre na sua conta para consultar a rede.</p>
      <NuxtLink to="/entrar">Entrar</NuxtLink>
    </section>
    <section v-else-if="state.kind === 'error'" aria-label="Falha na consulta">
      <p role="alert">
        Não foi possível confirmar seus dados. Tente novamente.
      </p>
      <button type="button" @click="discover()">Tentar novamente</button>
    </section>
    <template v-else-if="ready">
      <FarmScopeSelector
        :ready="ready"
        @select="selectFarm"
        @discover="discover"
      />
      <p v-if="failure" role="alert">
        {{ failure }}
        <button type="button" @click="load()">Tentar novamente</button>
      </p>
      <p v-if="!ready.scope">Selecione uma farm para ver a rede.</p>
      <p v-else-if="loading && !data" role="status" aria-busy="true">
        Carregando a rede…
      </p>
      <FarmMap
        v-else-if="data"
        :entries="entries"
        :now="now.wall || Date.now()"
        :live="liveAgents.size > 0"
        :as-of="readAt"
      />
    </template>
  </main>
</template>
