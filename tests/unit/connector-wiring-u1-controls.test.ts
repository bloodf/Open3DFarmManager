import { afterEach, expect, test, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  agentSetup,
  moonrakerSimulator,
  waitFor,
} from './connector-wiring-sims.ts'

// Keep the real agent, pause runtime and detection; replace only the cloud
// signalling transport and capture what the snapshot source would advertise.
const probe = vi.hoisted(() => ({
  controlsFor: undefined as
    | ((assignmentId: string) => readonly ExtendedControlAction[] | undefined)
    | undefined,
}))
vi.mock('../../packages/connector/src/runtime/signalling.ts', () => ({
  async runSignallingLifecycle({ signal }: { signal: AbortSignal }) {
    if (!signal.aborted)
      await new Promise((resolve) =>
        signal.addEventListener('abort', resolve, { once: true }),
      )
  },
}))
vi.mock(
  '../../packages/connector/src/runtime/farm-snapshot-provider.ts',
  async (original) => {
    const actual =
      await original<
        typeof import('../../packages/connector/src/runtime/farm-snapshot-provider.ts')
      >()
    return {
      ...actual,
      createFarmSnapshotSource(
        input: Parameters<typeof actual.createFarmSnapshotSource>[0],
      ) {
        probe.controlsFor = input.controlsFor
        return actual.createFarmSnapshotSource(input)
      },
    }
  },
)
const { runConnectorAgent } =
  await import('../../packages/connector/src/runtime/agent.ts')

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  probe.controlsFor = undefined
})

const objects = [
  'webhooks',
  'print_stats',
  'virtual_sdcard',
  'toolhead',
  'extruder',
  'extruder1',
  'extruder2',
  'extruder3',
  'heater_bed',
  'fan',
]

async function advertised(model: string | undefined) {
  const moonraker = await moonrakerSimulator({ spoolId: 'absent', objects })
  cleanup.push(moonraker.stop)
  const origin = 'https://127.0.0.1:1'
  const signalling = {
    origin,
    audience: 'fixture',
    endpoint: origin.replace('https:', 'wss:') + '/api/signalling/connector',
  }
  const setup = agentSetup({
    collection: () => ({
      version: 1,
      allowedOrigins: [moonraker.origin],
      printers: [
        {
          printerKey: 'printer',
          origin: moonraker.origin,
          ...(model ? { model } : {}),
        },
      ],
    }),
    assignmentExtra: { moonraker_origin: moonraker.origin },
    extra: ({ assignment }) => ({
      signalling,
      pause: {
        version: 1,
        control: { assignmentId: assignment },
        issuers: [
          {
            issuer: 'fixture',
            kid: 'fixture',
            publicKeySpki: generateKeyPairSync('ed25519')
              .publicKey.export({ format: 'der', type: 'spki' })
              .toString('base64url'),
          },
        ],
        signalling: {
          ...signalling,
          endpoint:
            origin.replace('https:', 'wss:') +
            '/api/signalling/pause-connector',
          credentialAudience: 'fixture',
        },
      },
    }),
  })
  cleanup.push(setup.remove)
  const controller = new AbortController()
  let failure: unknown
  const running = runConnectorAgent({
    configPath: setup.configPath,
    credentialPath: setup.credentialPath,
    dataDirectory: setup.directory,
    signal: controller.signal,
    onDiagnostic(value) {
      if (value.kind === 'pause-failed') failure = Error('pause-failed')
    },
  }).catch((error: unknown) => {
    failure = error
  })
  cleanup.push(async () => {
    controller.abort()
    await running
  })
  // Detection is done once the printer's own object list was read.
  await waitFor(() => {
    if (failure) throw failure
    return (
      probe.controlsFor !== undefined &&
      moonraker.methods.includes('printer.objects.list') &&
      moonraker.methods.includes('server.info')
    )
  }, 'Moonraker capability detection')
  await new Promise((resolve) => setTimeout(resolve, 200))
  return {
    controls: probe.controlsFor!(setup.ids.assignment),
    methods: moonraker.methods,
  }
}

test('a declared Snapmaker U1 advertises the U1 command capability set', async () => {
  const { controls, methods } = await advertised('Snapmaker U1')
  expect(controls).toEqual([
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_tool_temperature',
    'home',
    'jog',
    'start_print',
    'start_library_print',
  ])
  expect(
    methods.some((method) => /gcode|print\.(pause|cancel|resume)/.test(method)),
  ).toBe(false)
})

test('the same printer without the U1 declaration keeps generic Moonraker controls', async () => {
  const { controls } = await advertised(undefined)
  expect(controls).toEqual(
    expect.arrayContaining(['pause', 'resume', 'cancel', 'set_temperature']),
  )
})
