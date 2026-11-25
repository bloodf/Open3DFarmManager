// Stands in for composables/useFarmView.ts in the camera, library and files
// design captures: one authenticated farm with fixed printers and a drawn
// camera frame. Nothing connects to a Connector or a printer.
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'

const ROWS = [
  ['a1', 'Ender da bancada'],
  ['a2', 'Voron 2.4'],
] as const

function rows() {
  const clock = { wall: Date.now(), mono: performance.now() }
  return ROWS.map(([assignmentId, printerKey]) => ({
    assignment: {
      assignmentId,
      agentId: 'agent',
      printerKey,
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: 'authenticated',
    observation: {
      state: {
        state: 'idle',
        observedAt: clock.wall,
        controls: ['start_print'],
      },
      received: clock,
      historical: false,
      sourceClockComparable: true,
    },
  }))
}

/** A still frame drawn on a canvas, so the video element reaches `playing`. */
function drawnStream(): MediaStream {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const context = canvas.getContext('2d')!
  const paint = () => {
    context.fillStyle = 'dimgray'
    context.fillRect(0, 0, 640, 360)
    context.fillStyle = 'darkgray'
    context.fillRect(120, 250, 400, 24)
    context.fillStyle = 'silver'
    context.fillRect(270, 150, 100, 100)
  }
  paint()
  const stream = canvas.captureStream(10)
  setInterval(paint, 100)
  return stream
}

export function useFarmView() {
  const current = shallowRef(rows())
  const timer = setInterval(() => (current.value = rows()), 500)
  onBeforeUnmount(() => clearInterval(timer))
  const state = computed(() => ({
    kind: 'ready' as const,
    accountId: 'conta',
    scope: { accountId: 'conta', farmId: 'oficina', viewEpoch: 1 },
    farms: [{ farmId: 'oficina' }],
    keys: {
      kind: 'available' as const,
      selected: 'navegador',
      choices: [{ keyId: 'navegador' }],
    },
    inventory: 'ready',
    rows: current.value,
  }))
  let camera: MediaStream | undefined
  return {
    state,
    ready: state,
    now: ref({ wall: Date.now(), mono: performance.now() }),
    cameraFor: () => (camera ??= drawnStream()),
    discover: async () => {},
    selectFarm: async () => {},
    selectKey: () => {},
  }
}
