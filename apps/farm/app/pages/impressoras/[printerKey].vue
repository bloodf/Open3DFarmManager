<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import SystemServicesPanel from '../../components/printer-detail/SystemServicesPanel.vue'
import WebcamsPanel from '../../components/printer-detail/WebcamsPanel.vue'
import type { WebcamDetailOptions } from '../../utils/webrtc/readonly-peer.ts'
import PrinterDetailDashboard from '../../components/printer-detail/PrinterDetailDashboard.vue'
import { useFarmControls } from '../../components/farm/useFarmControls.ts'
import { useFarmView } from '../../composables/useFarmView.ts'
import type {
  ExtendedControlAction,
  QueueOpArguments,
} from '../../../../../packages/farm-protocol/src/control-actions.ts'
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
const initialPrinterKey = String(route.params.printerKey ?? '')
const webcams = shallowRef<
  Parameters<WebcamDetailOptions['onUpdate']>[0] | null
>(null)
const systemFrame =
  shallowRef<Parameters<NonNullable<WebcamDetailOptions['onDetail']>>[0]>()
const view = useFarmView({
  onDetail(frame) {
    if (frame.capabilities.includes('system')) systemFrame.value = frame
  },
  printerKey: initialPrinterKey,
  onUpdate(value) {
    webcams.value = value
  },
  onClose() {
    webcams.value = null
  },
})
definePageMeta({ key: (route) => route.path })
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
// Motion capabilities come from the controls the Connector advertises.
const capabilities = computed<DetailCapability[] | undefined>(() => {
  const controls = state.value?.controls
  const found: DetailCapability[] = [
    ...(systemFrame.value?.capabilities.includes('system')
      ? (['system'] as const)
      : []),
    ...(heaters.value.length ? (['heaters'] as const) : []),
    ...(controls?.includes('queue_op') ? (['job-queue'] as const) : []),
    ...(controls?.includes('jog') ? (['motion'] as const) : []),
    ...(controls?.includes('set_factor') ? (['speed', 'flow'] as const) : []),
  ]
  return found.length ? found : undefined
})
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

function availability(action: ExtendedControlAction) {
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
const outputs = computed(() => {
  const controls = state.value?.controls ?? []
  const advertised = {
    fan: controls.includes('set_fan'),
    led: controls.includes('set_led'),
    pin: controls.includes('set_pin'),
  }
  // The panel is one form set: it is on only when every advertised action is.
  const blocked = (
    [
      ['set_fan', advertised.fan],
      ['set_led', advertised.led],
      ['set_pin', advertised.pin],
    ] as const
  )
    .filter(([, offered]) => offered)
    .map(([action]) => availability(action))
    .find((item) => !item.available)
  return {
    advertised,
    canCommand: !blocked && !commandInFlight.value,
    reason: blocked
      ? blocked.reason
      : commandInFlight.value
        ? 'Um comando já está em andamento.'
        : undefined,
  }
})
const serviceAvailability = computed(() => availability('service'))
const queueAvailability = computed(() => availability('queue_op'))
const queue = computed(() => {
  const advertised = state.value?.controls?.includes('queue_op') ?? false
  return {
    advertised,
    canCommand: queueAvailability.value.available && !commandInFlight.value,
    reason: queueAvailability.value.available
      ? 'Um comando já está em andamento.'
      : advertised
        ? queueAvailability.value.reason
        : undefined,
  }
})
const motionAvailability = computed(() =>
  Object.fromEntries(
    (
      [
        ['home', 'home'],
        ['jog', 'jog'],
        ['motors_off', 'motors_off'],
        ['z_babystep', 'z_babystep'],
        ['set_factor', 'set_factor'],
      ] as const
    ).map(([control, action]) => {
      const result = availability(action)
      return [
        control,
        commandInFlight.value
          ? { available: false, reason: 'Um comando já está em andamento.' }
          : result.available
            ? { available: true }
            : { available: false, reason: result.reason },
      ]
    }),
  ),
)

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
function control(
  action: ExtendedControlAction,
  event: Event,
  args: Record<string, unknown> = {},
) {
  if (row.value) void openControl(row.value, action, event, args)
}
function extrude(tool: number, lengthMm: number, feed: number, event: Event) {
  if (row.value)
    void openControl(row.value, 'extrude', event, {
      tool,
      length_mm: lengthMm,
      feed,
    })
}
function setFan(fan: string, percent: number, event: Event) {
  if (row.value) void openControl(row.value, 'set_fan', event, { fan, percent })
}
function setLed(
  name: string,
  channels: { r: number; g: number; b: number; w?: number },
  event: Event,
) {
  if (row.value)
    void openControl(row.value, 'set_led', event, { name, ...channels })
}
function setPin(name: string, value: number, event: Event) {
  if (row.value) void openControl(row.value, 'set_pin', event, { name, value })
}
function queueOp(args: QueueOpArguments, event: Event) {
  if (row.value) void openControl(row.value, 'queue_op', event, args)
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
      :motion-availability="motionAvailability"
      @home="(event) => control('home', event, { axes: ['x', 'y', 'z'] })"
      @jog="
        (axis, distance, feed, event) =>
          control('jog', event, { axis, distance_mm: distance, feed })
      "
      @motors-off="(event) => control('motors_off', event)"
      @z-babystep="
        (delta, event) => control('z_babystep', event, { delta_mm: delta })
      "
      @set-factor="
        (speed, flow, event) =>
          control('set_factor', event, { speed_pct: speed, flow_pct: flow })
      "
      :extrusion="extrusion"
      :queue="queue"
      :macros="macros"
      :outputs="outputs"
      @set-temperature="setTemperature"
      @extrude="extrude"
      @queue-op="queueOp"
      @run-macro="runMacro"
      @set-fan="setFan"
      @set-led="setLed"
      @set-pin="setPin"
      @emergency-stop="emergencyStop"
    >
      <template #sistema>
        <SystemServicesPanel
          :firmware="systemFrame?.detail.firmware"
          :host="systemFrame?.detail.host"
          :updates="systemFrame?.detail.updates"
          :can-command="
            live && serviceAvailability.available && !commandInFlight
          "
          :reason="
            commandInFlight
              ? 'Um comando já está em andamento.'
              : serviceAvailability.reason
          "
          @restart="(op, event) => control('service', event, { op })"
        />
      </template>
    </PrinterDetailDashboard>
    <WebcamsPanel
      v-if="row && live && webcams && printerKey === initialPrinterKey"
      :webcams="webcams"
      :stream-for="
        (uid) => (row ? view.cameraFor(row.assignment.assignmentId, uid) : null)
      "
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
