import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import {
  OFFLINE_CONNECTION_LABEL,
  lastKnownStateAgeLabel,
  lastKnownStateAgeSeconds,
  lastKnownStatesFailureReason,
  offlineCards,
  parseLastKnownStates,
  type LastKnownState,
} from '../../apps/farm/app/composables/useLastKnownStates-core.ts'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  farmRef,
  settleFarmUpdates,
} from '../../apps/farm/app/composables/useLastKnownStates-ref.ts'
import {
  createLastKnownStates,
  useLastKnownStates,
} from '../../apps/farm/app/composables/useLastKnownStates.ts'
import {
  controlActionAvailability,
  getPrinterActionButtons,
} from '../../apps/farm/app/utils/farm-control.ts'
import { livePauseAvailability } from '../../apps/farm/app/utils/farm-pause.ts'
import type {
  FarmKeyState,
  FarmRow,
} from '../../apps/farm/app/utils/farm-view.ts'

const farmId = '11111111-1111-4111-8111-111111111111'
const otherFarmId = '55555555-5555-4555-8555-555555555555'
const assignmentA = '22222222-2222-4222-8222-222222222222'
const assignmentB = '33333333-3333-4333-8333-333333333333'
const otherAssignment = '44444444-4444-4444-8444-444444444444'

/** One clock reading for the whole test: the age never mixes readings. */
const nowWallMs = 1_700_000_000_000

function storedState(overrides: Partial<LastKnownState> = {}): LastKnownState {
  return {
    assignmentId: assignmentA,
    printerKey: 'printer-alpha',
    state: 'printing',
    progress: 0.42,
    temperatures: { toolCelsius: 210.5, bedCelsius: 59.5 },
    observedAt: nowWallMs - 120_000,
    ...overrides,
  }
}

/**
 * The published shape of the route. It is spelled out here instead of imported
 * from the server so the test proves the browser side against the documented
 * contract, not against whatever the server currently returns.
 */
function routeBody(states: readonly LastKnownState[]) {
  return {
    states: states.map((state) => ({
      assignmentId: state.assignmentId,
      printerKey: state.printerKey,
      state: state.state,
      progress: state.progress,
      temperatures: state.temperatures,
      observedAt: state.observedAt,
    })),
  }
}

// --- The offline card, rendered from the real component -------------------

/**
 * Renders the component the page ships. The component under test is the one
 * in the app tree, not a copy of it.
 */
function renderComponent(
  file: string,
  props: Record<string, unknown>,
): Promise<string> {
  return renderFarmComponent(file, props)
}

// --- The route, served on an ephemeral loopback port ----------------------

type ServerFixture = { url: string; close: () => Promise<void> }

/**
 * Serves the stored states over HTTP on an ephemeral loopback port. The
 * handler answers the route body, so the browser side reads a real response.
 */
async function serve(
  handler: (request: Request) => Promise<unknown>,
): Promise<ServerFixture> {
  const server: Server = createServer((req: IncomingMessage, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const request = new Request(url.href, { method: req.method ?? 'GET' })
      try {
        const body = await handler(request)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body ?? null))
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'status' in error
            ? Number((error as { status: unknown }).status)
            : 500
        const message =
          error && typeof error === 'object' && 'message' in error
            ? String((error as { message: unknown }).message)
            : 'Erro interno.'
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ statusCode: status, message }))
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

// --- Acceptance criterion 1: the controls stay disabled --------------------

test('the offline card offers no command control', async () => {
  const html = await renderComponent('LastKnownStates.vue', {
    state: storedState(),
    nowWallMs,
  })
  // A command would need a button; the offline card carries none.
  assert.doesNotMatch(html, /<button/i)
  assert.doesNotMatch(
    html,
    /Pausar impressão|Confirmar pausa|Retomar|Cancelar impressão/i,
  )
  // The read-only reason is announced instead.
  assert.match(html, /Somente leitura/)
})

test('a row without a live connection keeps every command disabled', () => {
  const keys: FarmKeyState = {
    kind: 'available',
    choices: [{ keyId: 'key-1', thumbprint: 'thumb-1' }],
    selected: 'key-1',
  }
  const clock = { wall: nowWallMs, mono: nowWallMs }
  // The stored state never produces an authenticated row: the page keeps the
  // live rows read-only until the feed authenticates.
  const row: FarmRow = {
    assignment: {
      assignmentId: assignmentA,
      agentId: '55555555-5555-4555-8555-555555555555',
      printerKey: 'printer-alpha',
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: 'unavailable',
    localOrigin: null,
    observation: null,
  }
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    const availability = controlActionAvailability(
      action,
      row,
      keys,
      true,
      clock,
    )
    assert.equal(availability.available, false)
    assert.match(
      (availability as { reason: string }).reason,
      /Não há conexão direta ao vivo/,
    )
    const buttons = getPrinterActionButtons(row, keys, true, false, clock)
    assert.equal(
      buttons.every((button) => button.disabled),
      true,
    )
  }
  const pause = livePauseAvailability(row, keys, true, () => clock)
  assert.equal(pause.available, false)
  assert.match(
    (pause as { reason: string }).reason,
    /Não há conexão direta ao vivo/,
  )
})

// --- Acceptance criterion 2: the data age comes from observedAt ------------

test('the data age of the offline card comes from observedAt', async () => {
  const observedAt = nowWallMs - 120_000
  const html = await renderComponent('LastKnownStates.vue', {
    state: storedState({ observedAt }),
    nowWallMs,
  })
  // Two minutes, read from the single clock reading of the test.
  assert.match(html, /Observação com 2 min/)
  assert.match(html, /Idade da observação/)
  // The observation instant is not presented as the age.
  assert.doesNotMatch(html, /1_700_000_000_000/)
})

test('the age label is measured from observedAt alone', () => {
  assert.equal(lastKnownStateAgeSeconds(nowWallMs, nowWallMs), 0)
  assert.equal(lastKnownStateAgeSeconds(nowWallMs - 45_000, nowWallMs), 45)
  assert.equal(lastKnownStateAgeSeconds(nowWallMs - 120_000, nowWallMs), 120)
  assert.match(
    lastKnownStateAgeLabel(nowWallMs - 120_000, nowWallMs),
    /Observação com 2 min/,
  )
  // A state observed in the future cannot be read as "just updated".
  assert.equal(lastKnownStateAgeSeconds(nowWallMs + 5_000, nowWallMs), null)
  assert.match(
    lastKnownStateAgeLabel(nowWallMs + 5_000, nowWallMs),
    /Idade da observação não confirmada/,
  )
})

// --- Acceptance criterion 3: the switch to live does not duplicate cards ---

test('switching to live keeps one card per printer', () => {
  const stored = [
    storedState({ assignmentId: assignmentA, printerKey: 'printer-alpha' }),
    storedState({
      assignmentId: assignmentB,
      printerKey: 'printer-beta',
      state: 'idle',
      progress: undefined,
    }),
  ]
  // Before the feed connects, no live row owns a printer.
  assert.deepEqual(
    offlineCards([], stored).map((state) => state.assignmentId),
    [assignmentA, assignmentB],
  )
  // Once the feed reports a printer, the live card is the only card.
  const liveRows = [
    { assignment: { assignmentId: assignmentA }, connection: 'authenticated' },
    { assignment: { assignmentId: assignmentB }, connection: 'closed' },
    {
      assignment: { assignmentId: otherAssignment },
      connection: 'authenticated',
    },
  ]
  assert.deepEqual(
    offlineCards(liveRows, stored).map((state) => state.assignmentId),
    [assignmentB],
  )
})

test('the stored states are released when the live feed connects', async () => {
  const requests: string[] = []
  const fixture = await serve(async () => routeBody([storedState()]))
  try {
    const states: { kind: string; states?: readonly LastKnownState[] }[] = []
    const controller = createLastKnownStates({
      read: async (path) => {
        requests.push(path)
        const response = await fetch(`${fixture.url}${path}`)
        return await response.json()
      },
      changed: (next) => {
        states.push(next)
      },
    })
    await controller.load(farmId)
    assert.deepEqual(requests, [`/api/farms/${farmId}/printer-states`])
    assert.equal(states.at(-1)?.kind, 'ready')
    assert.equal(states.at(-1)?.states?.length, 1)

    // The live feed connects: the stored states are released, not re-read.
    await controller.load(undefined)
    assert.deepEqual(requests, [`/api/farms/${farmId}/printer-states`])
    assert.equal(states.at(-1)?.kind, 'idle')
    controller.dispose()
  } finally {
    await fixture.close()
  }
})

test('a farm change reads the stored states of the new farm only', async () => {
  const requests: string[] = []
  const fixture = await serve(async () => routeBody([storedState()]))
  try {
    const controller = createLastKnownStates({
      read: async (path) => {
        requests.push(path)
        const response = await fetch(`${fixture.url}${path}`)
        return await response.json()
      },
      changed: () => {},
    })
    await controller.load(farmId)
    await controller.load(otherFarmId)
    assert.deepEqual(requests, [
      `/api/farms/${farmId}/printer-states`,
      `/api/farms/${otherFarmId}/printer-states`,
    ])
    controller.dispose()
  } finally {
    await fixture.close()
  }
})

test('the composable releases the stored states when the feed connects', async () => {
  const fixture = await serve(async () => routeBody([storedState()]))
  try {
    const farm = farmRef<string | undefined>(farmId)
    const live = farmRef(false)
    const controller = useLastKnownStates({
      farmId: () => farm.value,
      live: () => live.value,
      read: async (path) => {
        const response = await fetch(`${fixture.url}${path}`)
        return await response.json()
      },
    })
    // While no feed is connected, the stored states are read and shown.
    await settleFarmUpdates()
    assert.equal(controller.state.value.kind, 'ready')
    assert.equal(controller.states.value.length, 1)

    // The feed connects: the stored states are released and nothing is read.
    live.value = true
    await settleFarmUpdates()
    assert.equal(controller.state.value.kind, 'idle')
    assert.equal(controller.states.value.length, 0)
    controller.dispose()
  } finally {
    await fixture.close()
  }
})

test('a malformed answer never becomes a printer card', () => {
  const parsed = parseLastKnownStates({ states: [{ assignmentId: 'a' }] })
  assert.equal(parsed.ok, false)
  assert.equal(
    parsed.ok === false ? parsed.reason : 'unexpected',
    'unavailable',
  )
  // A repeated assignment would render two cards for one printer.
  const repeated = parseLastKnownStates(
    routeBody([
      storedState({ assignmentId: assignmentA }),
      storedState({ assignmentId: assignmentA }),
    ]),
  )
  assert.equal(repeated.ok, false)
})

test('a rejected read reports why without inventing a state', () => {
  assert.equal(lastKnownStatesFailureReason(401), 'unauthorized')
  assert.equal(lastKnownStatesFailureReason(403), 'forbidden')
  // The runtime being off answers 404; it is not the member's fault.
  assert.equal(lastKnownStatesFailureReason(404), 'forbidden')
  assert.equal(lastKnownStatesFailureReason(503), 'unavailable')
  assert.equal(lastKnownStatesFailureReason(undefined), 'unavailable')
})

test('the offline card is labelled as having no direct connection', async () => {
  const html = await renderComponent('LastKnownStates.vue', {
    state: storedState(),
    nowWallMs,
  })
  assert.match(html, new RegExp(OFFLINE_CONNECTION_LABEL))
  assert.equal(OFFLINE_CONNECTION_LABEL, 'sem conexão direta')
})

test('parseLastKnownStates accepts optional nullable grouping metadata from printer-states', () => {
  const parsed = parseLastKnownStates({
    states: [
      {
        ...routeBody([storedState()]).states[0]!,
        displayName: 'Mesa 1',
        groupName: 'Protótipos',
        location: null,
        sortOrder: 0,
      },
    ],
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.states[0]?.displayName, 'Mesa 1')
  assert.equal(parsed.states[0]?.groupName, 'Protótipos')
  assert.equal(parsed.states[0]?.location, null)
  assert.equal(parsed.states[0]?.sortOrder, 0)
})
