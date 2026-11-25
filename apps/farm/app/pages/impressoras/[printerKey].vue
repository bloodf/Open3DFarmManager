<script setup lang="ts">
import BambuAlarmStatus from '../../components/printer-detail/BambuAlarmStatus.vue'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useRoute } from 'vue-router'
import ConfigEditorPanel from '../../components/printer-detail/ConfigEditorPanel.vue'
import { vendorDetailCatalog } from '../../utils/compatibility/detail-panels.ts'
import FileManagerPanel from '../../components/printer-detail/FileManagerPanel.vue'
import FarmMaterials from '../../components/FarmMaterials.vue'
import SpoolIllustration from '../../components/spool-library/SpoolIllustration.vue'
import ResinLedgerPanel from '../../components/resin/ResinLedgerPanel.vue'
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
import {
  actionDialogTitle,
  liveControlActionAvailability,
} from '../../utils/farm-control.ts'
import { printableFile } from '../../utils/files-view.ts'
import { kobraXInputs, kobraXMapping } from '../../utils/kobra-x-inputs.ts'
import { activeSlotSpools } from '../../utils/slot-spools.ts'
import { filamentLoadArgs } from '../../utils/filament-load.ts'
import { extendedLabel } from '../../utils/farm-control-extended.ts'
import {
  formatPrinterStateLabel,
  observationAge,
} from '../../utils/farm-view.ts'
import {
  applyDetailQuery,
  backfillHistory,
  downloadTimelapse,
  emptyDetailQueries,
  type DetailQueryState,
} from '../../utils/detail-query-view.ts'
import type { JobHistoryItem } from '../../utils/job-history-view.ts'
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
  detailFrame.value?.vendor && detailFrame.value.vendor !== 'bambu'
    ? detailFrame.value
    : undefined,
)
const vendorCatalog = computed(() => {
  const vendor = detailFrame.value?.vendor
  return vendor ? vendorDetailCatalog[vendor] : undefined
})
const printFile = ref('')
const kobraInputCount = ref(1)
const kobraInputs = ref(['', '', '', '', '', '', ''])
const availableKobraInputs = computed(() =>
  kobraXInputs(state.value?.materials),
)
const selectedKobraInputs = computed(() =>
  kobraInputs.value.map((selection) =>
    availableKobraInputs.value.find((input) => String(input.id) === selection),
  ),
)
const selectedKobraInput = computed(() => selectedKobraInputs.value[0])
const selectedLoadInputId = ref('')
const loadInputError = ref('')
const selectedLoadInput = computed(() =>
  availableKobraInputs.value.find(
    (input) => String(input.id) === selectedLoadInputId.value,
  ),
)
function loadFilament(event: Event) {
  const args = filamentLoadArgs(selectedLoadInput.value)
  if (!args) {
    loadInputError.value = 'Selecione uma entrada de filamento para carregar.'
    return
  }
  loadInputError.value = ''
  control('load_filament', event, args)
}
const selectedKobraMapping = computed(() =>
  kobraXMapping(
    kobraInputs.value,
    kobraInputCount.value,
    availableKobraInputs.value,
  ),
)
const canStartStoredFile = computed(
  () =>
    printableFile(printFile.value, vendorFrame.value?.vendor) &&
    (vendorFrame.value?.vendor !== 'kobra-x' ||
      /\.(3mf|gcode)$/i.test(printFile.value)),
)
function startStoredFile(event: Event) {
  if (!canStartStoredFile.value) return
  if (vendorFrame.value?.vendor === 'kobra-x') {
    if (!selectedKobraMapping.value) return
    control('start_print', event, {
      file: printFile.value,
      ams_mapping: selectedKobraMapping.value,
    })
    return
  }
  control('start_print', event, { file: printFile.value })
}
const systemFrame = computed(() =>
  detailFrame.value?.capabilities.includes('system')
    ? detailFrame.value
    : undefined,
)
const detailQueries = shallowRef<DetailQueryState>(emptyDetailQueries)
const consoleCommands = shallowRef<readonly string[]>([])
const consoleResponses = shallowRef<
  readonly { seq: number; lines: readonly string[] }[]
>([])
let consoleSequence = 0
const view = useFarmView({
  requestedFarm: () => route.query.farm,
  webcamDetail: {
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
    onQuery(frame) {
      detailQueries.value = applyDetailQuery(detailQueries.value, frame)
      if (frame.kind === 'temperature-store')
        history.value = backfillHistory(
          history.value,
          frame,
          Date.now(),
          Date.now(),
        )
    },
    // The queue and timelapse areas are advertised by the printer's controls.
    advertised: () => capabilities.value ?? [],
    printerKey: initialPrinterKey,
    onUpdate(value) {
      webcams.value = value
    },
    onClose() {
      webcams.value = null
      detailFrame.value = undefined
      consoleCommands.value = []
      detailQueries.value = emptyDetailQueries
    },
  },
})
definePageMeta({ key: (route) => route.path })
const { state: viewState, ready, now, discover } = view
const heading = ref<HTMLElement | null>(null)
const page = ref<HTMLElement | null>(null)
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
const loadFilamentConfirmationLabel = computed(() => {
  const target = pauseTarget.value
  if (target?.action !== 'load_filament') return undefined
  return (
    availableKobraInputs.value.find((input) => input.id === target.args.tray)
      ?.label ?? 'Não informado'
  )
})

const row = computed(
  () =>
    ready.value?.rows.find(
      (item) => item.assignment.printerKey === printerKey.value,
    ) ?? null,
)
const state = computed(() => row.value?.observation?.state)
const activeSpools = computed(() => {
  const current = ready.value
  return current?.scope && row.value
    ? activeSlotSpools({
        farmId: current.scope.farmId,
        row: row.value,
        inventory: current.spools,
        now: now.value,
      })
    : []
})
const spoolBySlot = computed(
  () => new Map(activeSpools.value.map((spool) => [spool.slot, spool])),
)
watch(
  availableKobraInputs,
  (inputs) => {
    if (selectedLoadInputId.value || !inputs.length) return
    const active = state.value?.materials?.find((material) => material.active)
    const activeInput = inputs.find((input) => {
      if (!active) return false
      const slot = /^(-1|0):([0-3])$/.exec(active.slot)
      if (!slot) return false
      return input.id === Number(slot[2]) + (slot[1] === '0' ? 4 : 0)
    })
    if (active && activeInput)
      selectedLoadInputId.value = String(activeInput.id)
  },
  { immediate: true },
)
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
const heaters = computed(() => {
  const observed = state.value ? heatersFromObservation(state.value) : []
  const reported =
    detailFrame.value?.printerKey === printerKey.value
      ? detailFrame.value.detail.heaters
      : undefined
  // Targets and power come from the detail feed when it reports the heater.
  return observed.map((heater) => {
    const found = reported?.find(
      ({ name }) =>
        name === heater.name ||
        (heater.name === 'heater_bed' && name === 'bed'),
    )
    return found
      ? {
          ...heater,
          ...(found.target === undefined ? {} : { target: found.target }),
          ...(found.power === undefined ? {} : { power: found.power }),
        }
      : heater
  })
})
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
  // What the detail feed itself advertises: print history, and the timelapse
  // files of printers whose controls do not list the plugin (Bambu SD card).
  for (const area of ['job', 'timelapse'] as const)
    if (
      detailFrame.value?.printerKey === printerKey.value &&
      detailFrame.value.capabilities.includes(area) &&
      !found.includes(area)
    )
      found.push(area)
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

// OpenFarm's own record of this printer's jobs, merged into the Histórico tab.
const openfarmJobs = shallowRef<readonly JobHistoryItem[]>([])
let queryAbort: AbortController | undefined
const jobAdvertised = computed(
  () => capabilities.value?.includes('job') ?? false,
)
watch(
  () => [jobAdvertised.value, ready.value?.scope?.farmId, printerKey.value],
  async ([advertised, farmId, key]) => {
    queryAbort?.abort()
    openfarmJobs.value = []
    if (!advertised || !farmId || !key) return
    const controller = (queryAbort = new AbortController())
    try {
      const page = await $fetch<{ jobs: JobHistoryItem[] }>(
        '/api/job-history',
        {
          query: { farmId, printerKey: key, limit: 50 },
          signal: controller.signal,
          retry: 0,
          timeout: 15000,
        },
      )
      if (!controller.signal.aborted) openfarmJobs.value = page.jobs
    } catch {
      // The printer's own history still shows; the merge simply has no OpenFarm rows.
    }
  },
  { immediate: true },
)
const historyError = computed(() =>
  detailQueries.value.errors.history
    ? 'Não foi possível consultar o histórico da impressora.'
    : undefined,
)
const jobHistory = computed(() => ({
  advertised: jobAdvertised.value,
  jobs: detailQueries.value.history ?? [],
  totals: detailQueries.value.totals ?? null,
  openfarmJobs: openfarmJobs.value,
  pending:
    jobAdvertised.value &&
    live.value &&
    !detailQueries.value.history &&
    !historyError.value,
  ...(historyError.value ? { error: historyError.value } : {}),
  replayHref: (sha: string) => `/biblioteca?versao=${encodeURIComponent(sha)}`,
}))

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
const configAdvertised = computed(
  () => state.value?.controls?.includes('config_write') === true,
)
const configReason = computed(() => {
  if (!ready.value?.canManage)
    return 'Apenas proprietários e administradores podem editar a configuração.'
  const status = availability('config_write')
  if (!status.available) return status.reason
  if (commandInFlight.value) return 'Um comando já está em andamento.'
})

async function withConfigSession<T>(
  signal: AbortSignal,
  operation: (
    session: Awaited<ReturnType<typeof connectFiles>>,
    key: string,
  ) => Promise<T>,
) {
  const current = row.value
  if (!current || !configAdvertised.value || configReason.value)
    throw Error(configReason.value || 'Editor de configuração indisponível.')
  let session: Awaited<ReturnType<typeof connectFiles>> | undefined
  const close = () => session?.close()
  signal.addEventListener('abort', close, { once: true })
  try {
    session = await connectFiles(current, signal)
    signal.throwIfAborted()
    return await operation(session, current.assignment.printerKey)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Configuração:'))
      throw error
    throw Error('Não foi possível concluir a operação de configuração.')
  } finally {
    signal.removeEventListener('abort', close)
    session?.close()
    await session?.dispose()
  }
}

function listConfig(signal: AbortSignal) {
  return withConfigSession(signal, async (session, key) => {
    const result = await session.listFiles(key, undefined, undefined, {
      config: true,
    })
    if (!result.ok) throw Error('Lista indisponível')
    return result.files.map(({ name }) => name)
  })
}

async function configHash(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function readConfig(path: string, signal: AbortSignal) {
  return withConfigSession(signal, async (session, key) => {
    let bytes: Uint8Array<ArrayBuffer> | undefined
    let sha256 = ''
    let backups: string[] = []
    let offset = 0
    do {
      signal.throwIfAborted()
      const result = await session.listFiles(key, undefined, undefined, {
        config: true,
        configPath: path,
        offset,
      })
      if (!result.ok || !result.config || result.download === undefined)
        throw Error('Arquivo indisponível')
      if (!bytes) {
        bytes = new Uint8Array(result.config.size)
        sha256 = result.config.sha256
        backups = result.config.backups
      }
      const chunk = atob(result.download)
      if (
        result.config.sha256 !== sha256 ||
        (chunk.length === 0 && offset < bytes.length)
      )
        throw Error('Arquivo incompleto')
      bytes.set(
        Uint8Array.from(chunk, (char) => char.charCodeAt(0)),
        offset,
      )
      offset += chunk.length
    } while (offset < bytes.length)
    if ((await configHash(bytes)) !== sha256) throw Error('Arquivo alterado')
    return {
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      sha256,
      backups,
    }
  })
}

function saveConfig(
  path: string,
  base_sha256: string,
  change: { text: string; restart: boolean } | { backup: string },
  signal: AbortSignal,
) {
  return withConfigSession(signal, async (session, key) => {
    let args: Record<string, unknown> = { path, base_sha256 }
    if ('backup' in change) args = { ...args, backup: change.backup }
    else {
      const bytes = new TextEncoder().encode(change.text)
      if (bytes.length > 1024 * 1024)
        throw Error('Configuração: limite de 1 MiB excedido.')
      const sha256 = await configHash(bytes)
      const result = await session.sendFile(
        {
          type: 'offer',
          config: true,
          transfer_id: crypto.randomUUID(),
          printer_key: key,
          name: path,
          size: bytes.length,
          sha256,
        },
        new Blob([bytes]),
        signal,
      )
      if (!result.ok) throw Error('Transferência recusada')
      args = { ...args, sha256, restart: change.restart }
    }
    signal.throwIfAborted()
    const result = await session.issueControlCommand('config_write', args)
    if (result !== 'applied')
      throw Error(
        result === 'outcome-unknown'
          ? 'Configuração: resultado incerto. Abra o arquivo e confira antes de tentar novamente.'
          : 'Configuração: gravação recusada. Confira o estado da impressora e abra o arquivo novamente.',
      )
  })
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
type Transfer =
  { kind: 'idle' } | { kind: 'busy' | 'done' | 'error'; message: string }
const transfer = shallowRef<Transfer>({ kind: 'idle' })
const playback = shallowRef<{ name: string; url: string } | undefined>()
let transferAbort: AbortController | undefined
function clearPlayback() {
  if (playback.value) URL.revokeObjectURL(playback.value.url)
  playback.value = undefined
}
onBeforeUnmount(() => {
  transferAbort?.abort()
  clearPlayback()
  queryAbort?.abort()
})
const timelapse = computed(() => {
  const advertised =
    (state.value?.controls?.includes('timelapse') ?? false) ||
    (detailFrame.value?.printerKey === printerKey.value &&
      detailFrame.value.capabilities.includes('timelapse'))
  const canTransfer =
    advertised &&
    live.value &&
    pauseEnabled.value &&
    transfer.value.kind !== 'busy' &&
    !commandInFlight.value &&
    (timelapseAvailability.value.available || availability('file_op').available)
  return {
    advertised,
    canCommand: timelapseAvailability.value.available && !commandInFlight.value,
    reason: timelapseAvailability.value.available
      ? 'Um comando já está em andamento.'
      : advertised
        ? timelapseAvailability.value.reason
        : undefined,
    files: detailQueries.value.timelapse?.files,
    rendering: detailQueries.value.timelapse?.rendering,
    canTransfer,
    transferReason: canTransfer
      ? undefined
      : transfer.value.kind === 'busy'
        ? 'Uma transferência já está em andamento.'
        : 'Reproduzir e baixar exigem conexão direta atual e autorizada.',
  }
})
const queueAvailability = computed(() => availability('queue_op'))
const queue = computed(() => {
  const advertised = state.value?.controls?.includes('queue_op') ?? false
  return {
    advertised,
    state: detailQueries.value.queue?.state,
    jobs: detailQueries.value.queue?.jobs,
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
const videoTypes: Record<string, string> = {
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  jpg: 'image/jpeg',
}
async function timelapseTransfer(
  kind: 'play' | 'download',
  file: string,
  _event: Event,
) {
  const current = row.value
  if (!current || !timelapse.value.canTransfer) return
  transferAbort?.abort()
  const controller = (transferAbort = new AbortController())
  transfer.value = { kind: 'busy', message: `Transferindo ${file}…` }
  let session: Awaited<ReturnType<typeof connectFiles>> | undefined
  try {
    session = await connectFiles(current, controller.signal)
    const bytes = await downloadTimelapse(
      session,
      current.assignment.printerKey,
      file,
      controller.signal,
    )
    const blob = new Blob([bytes], {
      type:
        videoTypes[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'video/mp4',
    })
    const url = URL.createObjectURL(blob)
    if (kind === 'play') {
      clearPlayback()
      playback.value = { name: file, url }
    } else {
      const link = document.createElement('a')
      link.href = url
      link.download = file.split('/').pop() ?? file
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
    transfer.value = {
      kind: 'done',
      message:
        kind === 'play'
          ? `${file} pronto para reprodução.`
          : `${file} baixado.`,
    }
  } catch {
    if (!controller.signal.aborted)
      transfer.value = {
        kind: 'error',
        message:
          'Não foi possível transferir o timelapse pela conexão direta. Tente novamente.',
      }
  } finally {
    session?.close()
    await session?.dispose()
    if (transferAbort === controller) transferAbort = undefined
  }
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
// Focus lands on the heading of the screen that was just shown (the status
// line, the alert or the printer name), but never steals focus from a control
// the user is already using.
function focusHeading() {
  const active = document.activeElement
  if (active && active !== document.body) return
  const target = heading.value ?? page.value?.querySelector<HTMLElement>('h1')
  target?.focus()
}
onMounted(() => heading.value?.focus())
watch(
  () => [viewState.value.kind, ready.value?.inventory, !!row.value] as const,
  async () => {
    await nextTick()
    focusHeading()
  },
)
</script>

<template>
  <main id="conteudo" ref="page" class="printer-page">
    <nav aria-label="Navegação da impressora">
      <ul class="nav-links">
        <li><NuxtLink to="/farm">Minha farm</NuxtLink></li>
        <li><NuxtLink to="/impressoras">Impressoras</NuxtLink></li>
      </ul>
    </nav>
    <div
      v-if="viewState.kind === 'loading' || ready?.inventory === 'loading'"
      class="loading panel"
      aria-busy="true"
    >
      <h1 class="page-title">Impressora</h1>
      <p ref="heading" role="status" tabindex="-1">Carregando a impressora…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <section
      v-else-if="viewState.kind === 'sign-in-required'"
      aria-label="Acesso à farm"
      class="panel"
    >
      <h1 ref="heading" tabindex="-1">Entre para ver a impressora</h1>
      <p>Entre na sua conta para consultar esta impressora.</p>
      <NuxtLink to="/entrar" class="cta">Entrar</NuxtLink>
    </section>
    <template v-else-if="viewState.kind === 'error'">
      <h1 class="page-title">Impressora</h1>
      <ErrorState title="Não foi possível carregar a impressora">
        <p ref="heading" role="alert" tabindex="-1">
          {{ farmViewErrorText(viewState.reason) }}
        </p>
        <div class="actions">
          <Button @click="discover()">Tentar novamente</Button>
          <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
        </div>
      </ErrorState>
    </template>
    <template v-else-if="!row">
      <h1 ref="heading" class="page-title" tabindex="-1">
        Impressora não encontrada
      </h1>
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
      :state-tone="
        state?.state === 'unknown' ? 'stale' : (state?.state ?? 'offline')
      "
      :connector-label="
        row.connection === 'authenticated'
          ? 'conexão direta ativa'
          : 'sem conexão direta'
      "
      :live="live"
      :vendor-catalog="vendorCatalog"
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
      :job-history="jobHistory"
      :macros="macros"
      :gcode-console="gcodeConsole"
      :outputs="outputs"
      @set-temperature="setTemperature"
      @extrude="extrude"
      @queue-op="queueOp"
      @timelapse-op="timelapseOp"
      @timelapse-transfer="timelapseTransfer"
      @run-macro="runMacro"
      @send-gcode="sendGcode"
      @set-fan="setFan"
      @set-led="setLed"
      @set-pin="setPin"
      @emergency-stop="emergencyStop"
    >
      <template #status>
        <BambuAlarmStatus
          v-if="
            live &&
            detailFrame?.vendor === 'bambu' &&
            detailFrame.printerKey === printerKey
          "
          :message="detailFrame.detail.print?.message ?? ''"
        />
        <FarmMaterials
          v-if="live && !vendorFrame?.detail.materials?.length"
          :materials="detailFrame?.detail.materials ?? state?.materials"
          :active-spools="activeSpools"
          :heading-level="2"
        />
      </template>
      <template #configuracao>
        <ConfigEditorPanel
          v-if="configAdvertised"
          :key="row.assignment.assignmentId"
          :reason="configReason"
          :list="listConfig"
          :read="readConfig"
          :save="saveConfig"
        />
      </template>
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
              : powerAvailability.available
                ? undefined
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
              : serviceAvailability.available
                ? undefined
                : serviceAvailability.reason
          "
          @restart="(op, event) => control('service', event, { op })"
        />
      </template>
    </PrinterDetailDashboard>
    <Button
      v-if="vendorCatalog && state?.controls?.includes('pause')"
      class="pause-button"
      :disabled="!availability('pause').available || commandInFlight"
      @click="(event: Event) => control('pause', event)"
    >
      Pausar impressão
    </Button>
    <section
      v-if="row && live && vendorFrame"
      aria-label="Detalhes da impressora"
      class="panel vendor-detail"
    >
      <h2>Impressão</h2>
      <p v-if="vendorFrame.detail.print?.file">
        {{ vendorFrame.detail.print.file }}
      </p>
      <p v-if="vendorFrame.detail.print?.progress !== undefined">
        Progresso: {{ Math.round(vendorFrame.detail.print.progress * 100) }}%
      </p>
      <Button
        v-if="
          vendorFrame.vendor === 'creality' && state?.controls?.includes('home')
        "
        :disabled="!availability('home').available || commandInFlight"
        @click="
          (event: Event) => control('home', event, { axes: ['x', 'y', 'z'] })
        "
      >
        Referenciar todos os eixos
      </Button>
      <form
        v-if="state?.controls?.includes('start_print')"
        class="print-form"
        @submit.prevent="startStoredFile"
      >
        <label for="detail-print-file">Nome do arquivo na impressora</label>
        <input
          id="detail-print-file"
          v-model.trim="printFile"
          required
          maxlength="255"
          :aria-describedby="
            vendorFrame.vendor === 'anycubic'
              ? 'detail-print-file-hint'
              : undefined
          "
        />
        <span
          v-if="vendorFrame.vendor === 'anycubic'"
          id="detail-print-file-hint"
        >
          Informe o nome de um arquivo .gcode já armazenado na impressora.
        </span>
        <template v-if="vendorFrame.vendor === 'kobra-x'">
          <label for="detail-kobra-count"
            >Quantidade de filamentos do arquivo</label
          >
          <select id="detail-kobra-count" v-model.number="kobraInputCount">
            <option v-for="count in 7" :key="count" :value="count">
              {{ count }}
            </option>
          </select>
          <template v-for="index in kobraInputCount" :key="index">
            <label :for="`detail-kobra-input-${index}`"
              >Entrada do filamento {{ index }}</label
            >
            <select
              :id="`detail-kobra-input-${index}`"
              v-model="kobraInputs[index - 1]"
              required
            >
              <option value="">Selecione uma entrada</option>
              <option
                v-for="input in availableKobraInputs"
                :key="input.id"
                :value="String(input.id)"
              >
                {{ input.label }}
              </option>
            </select>
            <SpoolIllustration
              v-if="selectedKobraInputs[index - 1]"
              :filament="{
                color_hex:
                  spoolBySlot.get(selectedKobraInputs[index - 1]!.material.slot)
                    ?.colorHex ??
                  selectedKobraInputs[index - 1]?.material.colorHex?.slice(
                    0,
                    6,
                  ),
              }"
              :spoolman-percent="
                spoolBySlot.get(selectedKobraInputs[index - 1]!.material.slot)
                  ?.remainingPercent
              "
              :printer-percent="
                selectedKobraInputs[index - 1]?.material.remainingPercent
              "
              compact
            />
          </template>
          <Button
            v-if="state?.controls?.includes('load_filament')"
            type="button"
            :disabled="
              !availability('load_filament').available || commandInFlight
            "
            @click="(event: Event) => loadFilament(event)"
          >
            Carregar filamento
          </Button>
          <label for="detail-load-filament-input">Entrada para carregar</label>
          <select
            id="detail-load-filament-input"
            v-model="selectedLoadInputId"
            :aria-describedby="
              loadInputError ? 'detail-load-filament-error' : undefined
            "
            @change="loadInputError = ''"
          >
            <option value="">Selecione uma entrada</option>
            <option
              v-for="input in availableKobraInputs"
              :key="input.id"
              :value="String(input.id)"
            >
              {{ input.label }}
            </option>
          </select>
          <span
            v-if="loadInputError"
            id="detail-load-filament-error"
            role="alert"
            >{{ loadInputError }}</span
          >
          <span
            >Selecione um arquivo .3mf ou .gcode já armazenado na
            impressora.</span
          >
          <span v-if="!availableKobraInputs.length"
            >Nenhuma entrada de filamento disponível na observação atual.</span
          >
        </template>
        <Button
          type="submit"
          :disabled="
            (vendorFrame.vendor === 'kobra-x' && !selectedKobraMapping) ||
            !availability('start_print').available ||
            commandInFlight ||
            !canStartStoredFile
          "
        >
          Iniciar impressão
        </Button>
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
          <Button
            v-if="state?.controls?.includes('set_fan')"
            :disabled="!availability('set_fan').available || commandInFlight"
            @click="
              (event: Event) => setFan(fan.name, fan.speed > 0 ? 0 : 100, event)
            "
          >
            {{
              fan.speed > 0 ? 'Desligar ventoinha' : 'Ligar ventoinha a 100%'
            }}
          </Button>
        </div>
      </template>
      <template v-if="vendorFrame.detail.lights?.length">
        <h2>Iluminação</h2>
        <p>
          {{ vendorFrame.detail.lights[0]?.white ? 'Ligada' : 'Desligada' }}
        </p>
        <Button
          v-if="state?.controls?.includes('set_light')"
          :disabled="!availability('set_light').available || commandInFlight"
          @click="
            (event: Event) =>
              control('set_light', event, {
                on: !vendorFrame?.detail.lights?.[0]?.white,
              })
          "
        >
          {{
            vendorFrame.detail.lights[0]?.white ? 'Desligar luz' : 'Ligar luz'
          }}
        </Button>
      </template>
      <FarmMaterials
        v-if="vendorFrame.detail.materials?.length"
        :materials="vendorFrame.detail.materials"
        :active-spools="activeSpools"
        :title="vendorFrame.vendor === 'creality' ? 'Slots CFS' : 'Slots ACE'"
        :heading-level="2"
      />
    </section>

    <ResinLedgerPanel
      v-if="row && ready?.scope?.farmId"
      :key="row.assignment.assignmentId"
      :farm-id="ready.scope.farmId"
      :printer-key="row.assignment.printerKey"
    />

    <section
      v-if="row && (playback || transfer.kind !== 'idle')"
      aria-labelledby="timelapse-playback-title"
      class="panel"
    >
      <h2 id="timelapse-playback-title">Transferência de timelapse</h2>
      <p
        :role="transfer.kind === 'error' ? 'alert' : 'status'"
        aria-live="polite"
      >
        {{ transfer.kind === 'idle' ? '' : transfer.message }}
      </p>
      <template v-if="playback">
        <video
          :src="playback.url"
          controls
          muted
          :aria-label="`Reprodução de ${playback.name} (sem áudio)`"
        >
          <track
            kind="captions"
            src="data:text/vtt,WEBVTT"
            srclang="pt-BR"
            label="Sem áudio"
          />
        </video>
        <Button type="button" @click="clearPlayback">Fechar reprodução</Button>
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
          {{
            pauseTarget.action === 'pause'
              ? actionDialogTitle('pause', pauseTarget.printerKey)
              : `${extendedLabel(pauseTarget.action)} — ${pauseTarget.printerKey}`
          }}
        </h2>
        <p id="pause-dialog-description">
          <template v-if="pauseTarget.action === 'power'">
            Confirme se deseja {{ pauseTarget.args.on ? 'ligar' : 'desligar' }}
            {{ pauseTarget.args.device }} nesta impressora.
          </template>
          <template v-else>Confirme o comando para esta impressora.</template>
          <template v-if="pauseTarget.action === 'load_filament'">
            Entrada selecionada:
            <strong>{{ loadFilamentConfirmationLabel }}</strong>.
          </template>
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
<style scoped>
.printer-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
  min-width: 0;
}
.printer-page > nav,
.printer-page > section,
.printer-page > .loading {
  margin: 0;
}
.nav-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.nav-links a,
.cta {
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  text-decoration: none;
  font-weight: var(--font-weight-semibold);
}
.nav-links a:hover,
.cta:hover {
  border-color: var(--color-accent);
}
.cta {
  justify-self: start;
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}
.page-title,
.panel > h1 {
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.page-title {
  margin: 0;
}
.page-title:focus-visible,
.panel h1:focus-visible,
.panel [role='status']:focus-visible,
.printer-page > .ui-card :deep([role='alert']:focus-visible),
.printer-page :deep(.printer-detail__header h1:focus-visible) {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-sm);
}
.printer-page > .ui-card {
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: none;
}
.printer-page > .ui-card :deep(h2) {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.printer-page > .ui-card :deep(p) {
  margin-block: 0 var(--space-3);
}
.panel,
.printer-page :deep(.printer-detail__header),
.printer-page :deep(.printer-detail > section),
.printer-page :deep([role='tabpanel'] > section) {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.panel > h1,
.panel > h2,
.printer-page :deep(.printer-detail > section > h2),
.printer-page :deep([role='tabpanel'] > section > h2) {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.panel > h1 {
  font-size: clamp(var(--font-size-xl), 4vw, var(--font-size-2xl));
}
.panel > p,
.printer-page :deep(.printer-detail > section > p),
.printer-page :deep([role='tabpanel'] > section > p) {
  margin-block: 0 var(--space-3);
}
.panel > :last-child,
.printer-page :deep(.printer-detail > section > :last-child),
.printer-page :deep([role='tabpanel'] > section > :last-child) {
  margin-bottom: 0;
}
.loading {
  display: grid;
  gap: var(--space-3);
}
.loading > h1,
.loading > p {
  margin: 0;
}
.printer-page :deep(.printer-detail) {
  display: grid;
  gap: var(--space-4);
}
.printer-page :deep(.printer-detail__header) {
  display: grid;
  gap: var(--space-3);
  justify-items: start;
}
.printer-page :deep(.printer-detail__header > *) {
  margin: 0;
}
.printer-page :deep(.printer-detail__header h1) {
  width: fit-content;
  max-width: 100%;
}
.printer-page :deep(.stale strong) {
  margin-inline-end: var(--space-2);
}
/* v-show hides a panel with an inline display: none, which wins over this. */
.printer-page :deep([role='tabpanel']) {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.printer-page :deep(.tabs) {
  margin: 0;
}
.pause-button {
  justify-self: start;
}
.vendor-detail > h2:not(:first-child) {
  margin-top: var(--space-4);
}
.print-form {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  margin-block: var(--space-3);
}
.print-form label {
  margin: 0;
  font-weight: var(--font-weight-semibold);
}
.print-form input {
  width: min(100%, 24rem);
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.panel video {
  display: block;
  width: 100%;
  max-width: 40rem;
  margin-bottom: var(--space-3);
}
dialog {
  color: var(--color-text);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-2);
}
dialog h2 {
  margin-top: 0;
  font-size: var(--font-size-lg);
  overflow-wrap: anywhere;
}
dialog .actions {
  margin-top: var(--space-4);
}
dialog .actions button {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-accent);
}
dialog .actions button:first-child:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-on-accent);
}
dialog .actions button:disabled {
  opacity: 0.6;
}
@media (max-width: 400px) {
  .panel,
  .printer-page :deep(.printer-detail__header),
  .printer-page :deep(.printer-detail > section),
  .printer-page :deep([role='tabpanel'] > section) {
    padding: var(--space-4);
  }
  .nav-links a {
    padding-inline: var(--space-3);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .nav-links a,
  .cta {
    transition: border-color 120ms ease-out;
  }
}
</style>
