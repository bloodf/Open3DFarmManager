// Shared Flashforge harness: the original synthetic simulator, the real router
// and driver, and signed commands through the shipped dispatcher. No printer.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type {
  ControlObservation,
  PreparedPauseDriver,
} from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  provisionFlashforgePrinter,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedFlashforgeControl } from '../../packages/connector/src/flashforge/control-driver.ts'
import {
  FLASHFORGE_CONTROLS,
  type FlashforgeModel,
  type FlashforgeQualification,
} from '../../packages/connector/src/flashforge/qualification.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { startStatefulFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import { flashforgeModels } from '../fixtures/flashforge/models.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from './command-v2-dispatch.ts'

export const MODELS = flashforgeModels.map((model) => ({
  ...model,
  name: model.name as FlashforgeModel,
  version: model.firmware[0]!,
}))
export const QUALIFIED: FlashforgeQualification[] = MODELS.map((model) => ({
  model: model.name,
  firmware: model.version,
}))
export const AD5X = MODELS[2]!

/** Four loaded or empty slots with the station reference's 1-4 numbering. */
export const station = () => ({
  slotCnt: 4,
  currentSlot: 1,
  currentLoadSlot: 0,
  stateAction: 0,
  stateStep: 0,
  slotInfos: [1, 2, 3, 4].map((slotId) => ({
    slotId,
    hasFilament: slotId !== 3,
    materialName: 'PLA',
    materialColor: '#FFFFFF',
  })),
})

type Scope = {
  assignment_id: string
  farm_id: string
  agent_id: string
  printer_key: string
}
const newScope = (): Scope => ({
  assignment_id: randomUUID(),
  farm_id: randomUUID(),
  agent_id: randomUUID(),
  printer_key: 'flashforge-1',
})

export async function printer(
  t: TestContext,
  model: (typeof MODELS)[number],
  scope = newScope(),
) {
  const sim = await startStatefulFlashforgeSimulator({
    ...model,
    detail: {
      ...model.detail,
      firmwareVersion: `v${model.version}`,
      ...(model.pid === 38 ? { matlStationInfo: station() } : {}),
    },
  })
  const directory = mkdtempSync(join(tmpdir(), 'flashforge-control-'))
  t.after(async () => {
    await sim.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const origin = `http://${sim.host}:${sim.port}`
  const credentialFile = join(directory, 'credential.json')
  writeFileSync(
    credentialFile,
    JSON.stringify({
      origin,
      serialNumber: 'FIXTURE-SERIAL',
      checkCode: 'fixture01',
    }),
    { mode: 0o600 },
  )
  const local = {
    family: 'flashforge' as const,
    printerKey: scope.printer_key,
    origin,
    credentialFile,
    expect: { serialNumber: 'FIXTURE-SERIAL', model: model.name },
    simulated: true,
    control: true as const,
  }
  return {
    sim,
    local,
    directory,
    binding: provisionFlashforgePrinter(scope, local),
  }
}

export const router = (
  qualified: FlashforgeQualification[] | undefined,
  observe: (
    binding: PrinterBinding,
    observation: ControlObservation | null,
  ) => boolean = () => true,
  clock = { monotonicNow: () => performance.now() },
) =>
  createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock,
    observe,
    ...(qualified ? { flashforgeQualifiedWrites: qualified } : {}),
  })

/** The shipped dispatcher and journal over the real router, signed commands. */
export async function signed(
  t: TestContext,
  model: (typeof MODELS)[number],
  qualified: FlashforgeQualification[] | undefined,
  /** Runs inside the send callback, just before the dispatcher's guard. */
  atSend?: (revoke: () => void) => void,
) {
  const authority = await createV2Authority(await nodeSigner())
  const target = await printer(t, model, {
    assignment_id: authority.ids.assignment_id,
    farm_id: authority.ids.farm_id,
    agent_id: authority.ids.agent_id,
    printer_key: authority.printerKey,
  })
  let outer: PrinterBinding
  let retired: Promise<void> | undefined
  /** What the dispatcher's send guard answered, in order. */
  const guards: boolean[] = []
  const session = await openV2Dispatch(authority, {
    capability: {
      role: 'owner',
      actions: [
        ...FLASHFORGE_CONTROLS.AD5X,
        'set_camera_stream',
        'unload_filament',
        'start_print',
      ],
    },
    loopback: {
      origin: 'http://127.0.0.1:7125',
      driver({ clock, observe }) {
        const routes = router(
          qualified,
          (_inner, observation) => observe(outer, observation),
          clock,
        )
        const inner = target.binding
        const driver: PreparedPauseDriver & {
          detect(binding: PrinterBinding): Promise<unknown>
        } = {
          detect: () => routes.detect(inner),
          controls: () => routes.controls(inner),
          resultWindowMs: (_binding, action) =>
            routes.resultWindowMs?.(inner, action),
          prepare(input) {
            outer = input.binding
            retired = undefined
            return routes.prepare({ binding: inner, signal: input.signal })
          },
          execute: (action, args, input) =>
            routes.execute(action, args, {
              ...input,
              binding: inner,
              beforeSend() {
                atSend?.(() => session.dispatcher.revoke(session.handle))
                const permitted = input.beforeSend()
                guards.push(permitted)
                return permitted
              },
            }),
          pauseOnce: (input) => routes.pauseOnce({ ...input, binding: inner }),
          waitForPaused: (input) =>
            routes.waitForPaused({ ...input, binding: inner }),
          closeAttempt() {
            retired = routes.closeAttempt(inner)
            return retired
          },
        }
        return driver
      },
    },
  })
  t.after(() => session.close())
  return {
    ...target,
    guards,
    async run(
      action: ExtendedControlAction,
      args: Record<string, unknown> = {},
    ) {
      const result = await session.dispatch(
        await authority.sign(
          {
            action,
            args,
            purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
          },
          session.now(),
        ),
      )
      await retired
      return result
    },
  }
}

export function request(binding: PrinterBinding, sent = { count: 0 }) {
  return {
    binding,
    signal: new AbortController().signal,
    beforeSend() {
      sent.count++
      return true
    },
  }
}

export async function open(t: TestContext, binding: PrinterBinding) {
  const driver = openFixedFlashforgeControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: () => {},
    signal: new AbortController().signal,
    pollMs: 20,
    timeoutMs: 1000,
    qualifiedWrites: QUALIFIED,
  })
  t.after(() => driver.close())
  await driver.prepare()
  return driver
}
