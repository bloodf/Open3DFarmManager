<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import FileManagerPanel from '../../components/printer-detail/FileManagerPanel.vue'
import PowerPanel from '../../components/printer-detail/PowerPanel.vue'
import SystemServicesPanel from '../../components/printer-detail/SystemServicesPanel.vue'
import WebcamsPanel from '../../components/printer-detail/WebcamsPanel.vue'
import type { WebcamDetailOptions } from '../../utils/webrtc/readonly-peer.ts'
import PrinterDetailDashboard from '../../components/printer-detail/PrinterDetailDashboard.vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { farmViewErrorText } from '../../utils/farm-view-error.ts'
import { useFarmControls } from '../../components/farm/useFarmControls.ts'
import { useFarmView } from '../../composables/useFarmView.ts'
import type {
  ExtendedControlAction,
  QueueOpArguments,
  TimelapseArguments,
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
const printerKey = computed(() => String(route.params.printerKey ?? ''))
const initialPrinterKey = String(route.params.printerKey ?? '')
const webcams = shallowRef<
  Parameters<WebcamDetailOptions['onUpdate']>[0] | null
>(null)
const detailFrame =
  shallowRef<Parameters<NonNullable<WebcamDetailOptions['onDetail']>>[0]>()
const vendorFrame = computed(() =>
  detailFrame.value?.vendor ? detailFrame.value : undefined,
)
const printFile = ref('')
const systemFrame = computed(() =>
  detailFrame.value?.capabilities.includes('system')
    ? detailFrame.value
    : undefined,
)
const consoleCommands = shallowRef<readonly string[]>([])
const consoleResponses = shallowRef<
  readonly { seq: number; lines: readonly string[] }[]
>([])
let consoleSequence = 0
const view = useFarmView({
  onGcodeHelp(commands) {
    consoleCommands.value = commands
  },
  onGcodeResponse(frame) {
    consoleResponses.value = [
      ...consoleResponses.value.slice(-999),
      { seq: consoleSequence++, lines: frame.lines },
    ]
  },
  onDetail(frame) {
    detailFrame.value = frame
  },
  printerKey: initialPrinterKey,
  onUpdate(value) {
    webcams.value = value
  },
  onClose() {
    webcams.value = null
    detailFrame.value = undefined
    consoleCommands.value = []
  },
})
definePageMeta({ key: (route) => route.path })
const { state: viewState, ready, now, discover } = view
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
  connectFiles,
  confirmControl,
  closePause,
} = useFarmControls(view, dialog)

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
    ...(controls?.includes('file_op') ? (['files'] as const) : []),
    ...(systemFrame.value?.capabilities.includes('system')
      ? (['system'] as const)
      : []),
    ...(heaters.value.length ? (['heaters'] as const) : []),
    ...(controls?.includes('power') ? (['power'] as const) : []),
    ...(controls?.includes('queue_op') ? (['job-queue'] as const) : []),
    ...(controls?.includes('timelapse') ? (['timelapse'] as const) : []),
    ...(controls?.includes('bed_mesh') ? (['bed-mesh'] as const) : []),
    ...(controls?.includes('jog') ? (['motion'] as const) : []),
    ...(controls?.includes('set_factor') ? (['speed', 'flow'] as const) : []),
    ...(controls?.includes('gcode') ? (['console'] as const) : []),
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
const excludeAvailability = computed(() => availability('exclude_object'))
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
    fan: !vendorFrame.value && controls.includes('set_fan'),
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
const powerAvailability = computed(() => availability('power'))
const serviceAvailability = computed(() => availability('service'))
const timelapseAvailability = computed(() => availability('timelapse'))
const timelapse = computed(() => {
  const advertised = state.value?.controls?.includes('timelapse') ?? false
  return {
    advertised,
    canCommand: timelapseAvailability.value.available && !commandInFlight.value,
    reason: timelapseAvailability.value.available
      ? 'Um comando já está em andamento.'
      : advertised
        ? timelapseAvailability.value.reason
        : undefined,
    // Play and download wait for the file-transfer channel of the session.
    canTransfer: false,
    transferReason:
      'Reproduzir e baixar exigem o canal de transferência de arquivos, ainda não aberto nesta sessão.',
  }
})
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
const bedMesh = computed(() => {
  const result = availability('bed_mesh')
  const one = commandInFlight.value
    ? { available: false, reason: 'Um comando já está em andamento.' }
    : result.available
      ? { available: true }
      : { available: false, reason: result.reason }
  return {
    mesh:
      live.value && detailFrame.value?.printerKey === printerKey.value
        ? detailFrame.value.detail.bedMesh
        : undefined,
    availability: Object.fromEntries(
      (['calibrate', 'load', 'save', 'remove', 'clear'] as const).map((op) => [
        op,
        one,
      ]),
    ),
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

const gcodeAvailability = computed(() => availability('gcode'))
const gcodeConsole = computed(() => ({
  advertised: state.value?.controls?.includes('gcode') ?? false,
  canCommand: gcodeAvailability.value.available && !commandInFlight.value,
  reason: gcodeAvailability.value.available
    ? 'Um comando já está em andamento.'
    : gcodeAvailability.value.reason,
  printerKey: printerKey.value,
  commands: consoleCommands.value,
  responses: consoleResponses.value,
  printing:
    state.value?.state === 'printing' || state.value?.state === 'paused',
}))

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
function timelapseOp(args: TimelapseArguments, event: Event) {
  if (row.value) void openControl(row.value, 'timelapse', event, args)
}
function sendGcode(line: string, event: Event) {
  if (row.value) void openControl(row.value, 'gcode', event, { line })
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
    <div
      v-if="viewState.kind === 'loading' || ready?.inventory === 'loading'"
      class="loading"
      aria-busy="true"
    >
      <p ref="heading" role="status" tabindex="-1">Carregando a impressora…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <section
      v-else-if="viewState.kind === 'sign-in-required'"
      aria-label="Acesso à farm"
    >
      <h1 ref="heading" tabindex="-1">Entre para ver a impressora</h1>
      <p>Entre na sua conta para consultar esta impressora.</p>
      <NuxtLink to="/entrar">Entrar</NuxtLink>
    </section>
    <ErrorState
      v-else-if="viewState.kind === 'error'"
      title="Não foi possível carregar a impressora"
    >
      <p ref="heading" role="alert" tabindex="-1">
        {{ farmViewErrorText(viewState.reason) }}
      </p>
      <div class="actions">
        <Button @click="discover()">Tentar novamente</Button>
        <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
      </div>
    </ErrorState>
    <template v-else-if="!row">
      <h1 ref="heading" tabindex="-1">Impressora não encontrada</h1>
      <EmptyState
        title="Nenhuma impressora com este identificador"
        description="Nenhuma impressora com este identificador está atribuída à farm selecionada."
      >
        <NuxtLink to="/impressoras">Ver impressoras da farm</NuxtLink>
      </EmptyState>
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
      :supported-only="vendorFrame?.vendor === 'creality'"
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
      :bed-mesh="bedMesh"
      @bed-mesh="(args, event) => control('bed_mesh', event, args)"
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
      :print-status="
        detailFrame?.printerKey === printerKey ? detailFrame : undefined
      "
      :exclude-available="
        live &&
        !!state?.controls?.includes('exclude_object') &&
        excludeAvailability.available &&
        !commandInFlight
      "
      :exclude-reason="
        !state?.controls?.includes('exclude_object')
          ? undefined
          : excludeAvailability.available
            ? 'Aguarde a conexão ou o comando em andamento.'
            : excludeAvailability.reason
      "
      @exclude-object="
        (name, event) => control('exclude_object', event, { name })
      "
      :extrusion="extrusion"
      :queue="queue"
      :timelapse="timelapse"
      :macros="macros"
      :gcode-console="gcodeConsole"
      :outputs="outputs"
      @set-temperature="setTemperature"
      @extrude="extrude"
      @queue-op="queueOp"
      @timelapse-op="timelapseOp"
      @run-macro="runMacro"
      @send-gcode="sendGcode"
      @set-fan="setFan"
      @set-led="setLed"
      @set-pin="setPin"
      @emergency-stop="emergencyStop"
    >
      <template #arquivos>
        <FileManagerPanel
          :key="row.assignment.assignmentId"
          :printer-key="row.assignment.printerKey"
          :farm-id="ready?.scope?.farmId ?? ''"
          :agent-id="row.assignment.agentId"
          :can-save="availability('file_op').available"
          :connect="(signal) => connectFiles(row!, signal)"
          :enabled="live && pauseEnabled && !commandInFlight"
          :can-edit="availability('file_op').available"
          :can-print="
            availability('start_print').available &&
            availability('file_op').available
          "
          @file-op="(args, event) => control('file_op', event, args)"
          @print="(file, event) => control('start_print', event, { file })"
        />
      </template>
      <template #sistema>
        <PowerPanel
          v-if="state?.controls?.includes('power')"
          :devices="
            live && detailFrame?.printerKey === printerKey
              ? detailFrame.detail.powerDevices
              : undefined
          "
          :can-command="live && powerAvailability.available && !commandInFlight"
          :reason="
            commandInFlight
              ? 'Um comando já está em andamento.'
              : powerAvailability.reason
          "
          @toggle="(args, event) => control('power', event, args)"
        />
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
    <section
      v-if="row && live && vendorFrame"
      aria-label="Detalhes da impressora"
    >
      <h2>Impressão</h2>
      <p v-if="vendorFrame.detail.print?.file">
        {{ vendorFrame.detail.print.file }}
      </p>
      <p v-if="vendorFrame.detail.print?.progress !== undefined">
        Progresso: {{ Math.round(vendorFrame.detail.print.progress * 100) }}%
      </p>
      <button
        v-if="
          vendorFrame.vendor === 'creality' && state?.controls?.includes('home')
        "
        type="button"
        :disabled="!availability('home').available || commandInFlight"
        @click="(event) => control('home', event, { axes: ['x', 'y', 'z'] })"
      >
        Referenciar todos os eixos
      </button>
      <form
        v-if="state?.controls?.includes('start_print')"
        @submit.prevent="
          (event) => control('start_print', event, { file: printFile })
        "
      >
        <label for="detail-print-file">Nome do arquivo na impressora</label>
        <input
          id="detail-print-file"
          v-model.trim="printFile"
          required
          maxlength="255"
        />
        <button
          type="submit"
          :disabled="!availability('start_print').available || commandInFlight"
        >
          Iniciar impressão
        </button>
      </form>
      <template v-if="vendorFrame.detail.fans?.length">
        <h2>Ventoinhas</h2>
        <div v-for="fan in vendorFrame.detail.fans" :key="fan.name">
          <p>
            {{
              fan.name === 'part'
                ? 'Peça'
                : fan.name === 'aux'
                  ? 'Auxiliar'
                  : 'Câmara'
            }}: {{ Math.round(fan.speed * 100) }}%
          </p>
          <button
            v-if="state?.controls?.includes('set_fan')"
            type="button"
            :disabled="!availability('set_fan').available || commandInFlight"
            @click="(event) => setFan(fan.name, fan.speed > 0 ? 0 : 100, event)"
          >
            {{
              fan.speed > 0 ? 'Desligar ventoinha' : 'Ligar ventoinha a 100%'
            }}
          </button>
        </div>
      </template>
      <template v-if="vendorFrame.detail.lights?.length">
        <h2>Iluminação</h2>
        <p>
          {{ vendorFrame.detail.lights[0]?.white ? 'Ligada' : 'Desligada' }}
        </p>
        <button
          v-if="state?.controls?.includes('set_light')"
          type="button"
          :disabled="!availability('set_light').available || commandInFlight"
          @click="
            (event) =>
              control('set_light', event, {
                on: !vendorFrame?.detail.lights?.[0]?.white,
              })
          "
        >
          {{
            vendorFrame.detail.lights[0]?.white ? 'Desligar luz' : 'Ligar luz'
          }}
        </button>
      </template>
      <template v-if="vendorFrame.detail.materials?.length">
        <h2>Slots ACE</h2>
        <ul>
          <li v-for="slot in vendorFrame.detail.materials" :key="slot.slot">
            {{ slot.slot
            }}<template v-if="slot.materialType">
              · {{ slot.materialType }}</template
            >
            <template v-if="slot.active"> · Em uso</template>
          </li>
        </ul>
      </template>
    </section>

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
          <template v-if="pauseTarget.action === 'power'">
            Confirme se deseja {{ pauseTarget.args.on ? 'ligar' : 'desligar' }}
            {{ pauseTarget.args.device }} nesta impressora.
          </template>
          <template v-else>Confirme o comando para esta impressora.</template>
          Ele será enviado diretamente ao Connector e não será repetido
          automaticamente.
        </p>
        <p v-if="pauseTarget.action === 'file_op'">
          {{
            { delete: 'Excluir', move: 'Mover', mkdir: 'Criar pasta' }[
              String(pauseTarget.args.op) as 'delete' | 'move' | 'mkdir'
            ]
          }}
          <strong>{{ pauseTarget.args.path }}</strong>
          <template v-if="pauseTarget.args.to">
            para <strong>{{ pauseTarget.args.to }}</strong></template
          >.
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
