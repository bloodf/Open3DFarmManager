<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import PrinterDetailDashboard from '../../components/printer-detail/PrinterDetailDashboard.vue'
import { useFarmControls } from '../../components/farm/useFarmControls.ts'
import { useFarmView } from '../../composables/useFarmView.ts'
import { liveControlActionAvailability } from '../../utils/farm-control.ts'
import { extendedLabel } from '../../utils/farm-control-extended.ts'
import {
  formatPrinterStateLabel,
  observationAge,
} from '../../utils/farm-view.ts'
import {
  heatersFromObservation,
  mergeSamples,
  samplesFromHeaters,
  type DetailCapability,
  type HeaterHistory,
} from '../../utils/printer-detail-view.ts'

const route = useRoute()
const view = useFarmView()
const { ready, now } = view
const heading = ref<HTMLElement | null>(null)
const pauseDialog = ref<HTMLDialogElement | null>(null)
const pauseCancel = ref<HTMLButtonElement | null>(null)
const dialog = {
  value: {
    show() {
      pauseDialog.value?.showModal()
      pauseCancel.value?.focus()
    },
    close() {
      pauseDialog.value?.close()
    },
  },
}
const {
  pauseEnabled,
  pauseTarget,
  pauseState,
  pauseRemaining,
  pauseStatus,
  commandInFlight,
  openControl,
  confirmControl,
  closePause,
} = useFarmControls(view, dialog)

const printerKey = computed(() => String(route.params.printerKey ?? ''))
const row = computed(
  () =>
    ready.value?.rows.find(
      (item) => item.assignment.printerKey === printerKey.value,
    ) ?? null,
)
const state = computed(() => row.value?.observation?.state)
const age = computed(() => {
  void now.value
  const observation = row.value?.observation
  return observation
    ? observationAge(observation, { wall: Date.now(), mono: performance.now() })
    : null
})
const live = computed(
  () =>
    row.value?.connection === 'authenticated' &&
    !!age.value &&
    !age.value.stale,
)
const heaters = computed(() =>
  state.value ? heatersFromObservation(state.value) : [],
)
const capabilities = computed<DetailCapability[] | undefined>(() =>
  heaters.value.length ? ['heaters'] : undefined,
)
const lastKnownText = computed(() =>
  age.value?.seconds == null ? undefined : `recebido há ${age.value.seconds} s`,
)

// Ten minutes of readings kept in memory while the page is open.
const history = shallowRef<HeaterHistory>({})
watch(
  () => row.value?.observation,
  (observation) => {
    if (!observation || observation.historical) return
    const time = observation.received.wall
    let next = history.value
    for (const [name, sample] of Object.entries(
      samplesFromHeaters(heaters.value, time),
    ))
      next = mergeSamples(next, name, [sample], Math.max(time, now.value.wall))
    history.value = next
  },
  { immediate: true },
)

function availability(
  action: 'set_temperature' | 'emergency_stop' | 'extrude' | 'run_macro',
) {
  void now.value
  const current = ready.value
  return row.value && current
    ? liveControlActionAvailability(
        action,
        row.value,
        current.keys,
        pauseEnabled.value,
      )
    : { available: false as const, reason: 'Impressora não carregada.' }
}
const temperatureAvailability = computed(() => availability('set_temperature'))
const stopAvailability = computed(() => availability('emergency_stop'))
const extrudeAvailability = computed(() => availability('extrude'))
const extrusion = computed(() => {
  const advertised = state.value?.controls?.includes('extrude') ?? false
  return {
    advertised,
    // Tool 0 is the reported extruder; only listed heaters are offered.
    tools: heaters.value.some(({ name }) => name === 'extruder') ? [0] : [],
    canCommand: extrudeAvailability.value.available && !commandInFlight.value,
    reason: extrudeAvailability.value.available
      ? 'Um comando já está em andamento.'
      : advertised
        ? extrudeAvailability.value.reason
        : undefined,
  }
})

const macroAvailability = computed(() => availability('run_macro'))
const macros = computed(() => {
  const advertised = state.value?.controls?.includes('run_macro') ?? false
  const params = state.value?.macroParams ?? {}
  return {
    advertised,
    list: (state.value?.macros ?? [])
      .filter((name) => !name.startsWith('_'))
      .map((name) => ({ name, params: params[name] ?? [] })),
    canCommand: macroAvailability.value.available && !commandInFlight.value,
    reason: !advertised
      ? undefined
      : macroAvailability.value.available
        ? 'Um comando já está em andamento.'
        : macroAvailability.value.reason,
  }
})

function setTemperature(heater: string, targetC: number, event: Event) {
  if (row.value)
    void openControl(row.value, 'set_temperature', event, {
      heater,
      target_c: targetC,
    })
}
function runMacro(
  name: string,
  params: Record<string, string> | undefined,
  event: Event,
) {
  if (row.value)
    void openControl(row.value, 'run_macro', event, {
      name,
      ...(params ? { params } : {}),
    })
}
function extrude(tool: number, lengthMm: number, feed: number, event: Event) {
  if (row.value)
    void openControl(row.value, 'extrude', event, {
      tool,
      length_mm: lengthMm,
      feed,
    })
}
function emergencyStop(event: Event) {
  if (row.value) void openControl(row.value, 'emergency_stop', event)
}
function cancelPause(event: Event) {
  // Esc closes the dialog, but never interrupts a command in flight.
  event.preventDefault()
  closePause()
}
onMounted(() => heading.value?.focus())
</script>

<template>
  <main id="conteudo">
    <nav aria-label="Navegação da impressora" class="actions">
      <NuxtLink to="/farm">Minha farm</NuxtLink>
      <NuxtLink to="/impressoras">Impressoras</NuxtLink>
    </nav>
    <p v-if="!ready" ref="heading" role="status" tabindex="-1">
      Carregando a impressora…
    </p>
    <template v-else-if="!row">
      <h1 ref="heading" tabindex="-1">Impressora não encontrada</h1>
      <p>
        Nenhuma impressora com este identificador está atribuída à farm
        selecionada.
      </p>
    </template>
    <PrinterDetailDashboard
      v-else
      :name="row.assignment.displayName || row.assignment.printerKey"
      :state-label="state ? formatPrinterStateLabel(state) : 'Sem dados'"
      :state-tone="state?.state ?? 'offline'"
      :connector-label="
        row.connection === 'authenticated'
          ? 'conexão direta ativa'
          : 'sem conexão direta'
      "
      :live="live"
      :last-known-text="lastKnownText"
      :capabilities="capabilities"
      :heaters="heaters"
      :history="history"
      :can-command="temperatureAvailability.available && !commandInFlight"
      :command-reason="
        temperatureAvailability.available
          ? 'Um comando já está em andamento.'
          : temperatureAvailability.reason
      "
      :can-emergency-stop="stopAvailability.available && !commandInFlight"
      :extrusion="extrusion"
      :macros="macros"
      @set-temperature="setTemperature"
      @extrude="extrude"
      @run-macro="runMacro"
      @emergency-stop="emergencyStop"
    />
    <dialog
      ref="pauseDialog"
      aria-labelledby="pause-dialog-title"
      aria-describedby="pause-dialog-description"
      @cancel="cancelPause"
    >
      <template v-if="pauseTarget">
        <h2 id="pause-dialog-title">
          {{ extendedLabel(pauseTarget.action) }} — {{ pauseTarget.printerKey }}
        </h2>
        <p id="pause-dialog-description">
          Confirme o comando para esta impressora. Ele será enviado diretamente
          ao Connector e não será repetido automaticamente.
        </p>
        <p role="status" aria-live="polite">{{ pauseStatus }}</p>
        <div class="actions">
          <button
            type="button"
            :disabled="pauseState.kind !== 'ready' || pauseRemaining <= 0"
            @click="confirmControl"
          >
            Confirmar comando
          </button>
          <button
            ref="pauseCancel"
            type="button"
            :disabled="pauseState.kind === 'sending'"
            @click="closePause"
          >
            {{
              pauseState.kind === 'settled' || pauseState.kind === 'failed'
                ? 'Fechar'
                : 'Cancelar'
            }}
          </button>
        </div>
      </template>
    </dialog>
  </main>
</template>

<style scoped src="../../components/farm/farm-view.css"></style>
