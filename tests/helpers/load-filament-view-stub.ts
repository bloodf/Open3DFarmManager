// SPDX-License-Identifier: AGPL-3.0-or-later
// Stands in for composables/useFarmView.ts in the page harness: the WebRTC
// session cannot run in-process, so the page reads one live Kobra X from here.
import { computed, shallowRef } from 'vue'

const printerKey = 'synthetic-printer'

export function useFarmView(options: {
  webcamDetail: { onDetail(frame: unknown): void }
}) {
  const wall = Date.now()
  const ready = shallowRef({
    kind: 'ready',
    farms: [],
    scope: { accountId: 'account', farmId: 'farm', viewEpoch: 1 },
    keys: { kind: 'available', selected: 'key', choices: [] },
    canManage: false,
    spools: [],
    rows: [
      {
        assignment: {
          assignmentId: 'assignment',
          agentId: 'agent',
          printerKey,
          status: 'active',
          connectorStatus: 'approved',
        },
        connection: 'authenticated',
        localOrigin: null,
        observation: {
          state: {
            printerKey,
            state: 'idle',
            observedAt: wall,
            controls: ['start_print', 'load_filament'],
            materials: [{ slot: '-1:0' }, { slot: '0:0' }],
          },
          received: { wall, mono: performance.now() },
          sourceClockComparable: true,
          historical: false,
        },
      },
    ],
  })
  options.webcamDetail.onDetail({
    printerKey,
    vendor: 'kobra-x',
    capabilities: [],
    detail: {},
  })
  return {
    state: computed(() => ready.value),
    ready,
    now: shallowRef({ wall, mono: performance.now() }),
    discover() {},
    selectFarm() {},
    selectKey() {},
    confirmOrigin() {},
    cameraFor: () => null,
  }
}
