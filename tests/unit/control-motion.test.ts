// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import AxeBuilder from '@axe-core/playwright'
import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import {
  ControlArguments,
  ExtendedControlAction,
  controlRoleAllowed,
  controlSourceState,
} from '../../packages/farm-protocol/src/control-actions.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  MotionRefusal,
  buildMotionScript,
  motionQueryWire,
  motionSupported,
  moonrakerMotionCommand,
  parseMotionState,
  refuseMotion,
  type MotionState,
} from '../../packages/connector/src/moonraker/control-motion.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import { moonrakerControls } from '../../packages/connector/src/moonraker/control-support.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  babystepDelta,
  factorRequest,
  jogRequest,
  positionText,
  unhomedAxes,
} from '../../apps/farm/app/components/printer-detail/motion-view.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockOptions,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const jog = { axis: 'x', distance_mm: 10, feed: 3000 }
const idle: MotionState = {
  ready: true,
  printState: 'standby',
  homedAxes: 'xyz',
  position: [100, 100, 10, 0],
  axisMinimum: [0, 0, 0, 0],
  axisMaximum: [220, 220, 250, 0],
}

describe('motion arguments', () => {
  it.each([
    ['jog', jog],
    ['jog', { axis: 'z', distance_mm: -0.01, feed: 60 }],
    ['jog', { axis: 'y', distance_mm: 100, feed: 18000 }],
    ['motors_off', {}],
    ['z_babystep', { delta_mm: 0.001 }],
    ['z_babystep', { delta_mm: -0.1 }],
    ['set_factor', { speed_pct: 10, flow_pct: 50 }],
    ['set_factor', { speed_pct: 300, flow_pct: 150 }],
  ])('accepts %s %j', (action, args) => {
    expect(ControlArguments.safeParse({ action, args }).success).toBe(true)
  })
  it.each([
    ['jog', { ...jog, axis: 'e' }],
    ['jog', { ...jog, distance_mm: 0.005 }],
    ['jog', { ...jog, distance_mm: 100.01 }],
    ['jog', { ...jog, distance_mm: 0 }],
    ['jog', { ...jog, distance_mm: 1.234 }],
    ['jog', { ...jog, feed: 59 }],
    ['jog', { ...jog, feed: 18001 }],
    ['jog', { ...jog, feed: 1.5 }],
    ['jog', { axis: 'x', distance_mm: 1 }],
    ['jog', { ...jog, extra: 1 }],
    ['jog', { ...jog, distance_mm: Number.NaN }],
    ['motors_off', { axis: 'x' }],
    ['z_babystep', { delta_mm: 0.0005 }],
    ['z_babystep', { delta_mm: 0.101 }],
    ['z_babystep', { delta_mm: 0 }],
    ['set_factor', { speed_pct: 9, flow_pct: 100 }],
    ['set_factor', { speed_pct: 301, flow_pct: 100 }],
    ['set_factor', { speed_pct: 100, flow_pct: 49 }],
    ['set_factor', { speed_pct: 100, flow_pct: 151 }],
    ['set_factor', { speed_pct: 100.5, flow_pct: 100 }],
    ['set_factor', { speed_pct: 100 }],
  ])('rejects %s %j', (action, args) => {
    expect(ControlArguments.safeParse({ action, args }).success).toBe(false)
  })
  it('is a signed, role-limited action and runs by state', () => {
    for (const action of ['jog', 'motors_off', 'z_babystep', 'set_factor'])
      expect(ExtendedControlAction.options).toContain(action)
    expect(controlRoleAllowed('operator', 'jog')).toBe(true)
    expect(controlRoleAllowed('viewer', 'jog')).toBe(false)
    expect(controlSourceState('jog', 'idle')).toBe(true)
    expect(controlSourceState('jog', 'printing')).toBe(false)
    expect(controlSourceState('jog', 'paused')).toBe(false)
    expect(controlSourceState('motors_off', 'printing')).toBe(false)
    expect(controlSourceState('z_babystep', 'printing')).toBe(true)
    expect(controlSourceState('set_factor', 'printing')).toBe(true)
    expect(controlSourceState('z_babystep', 'error')).toBe(false)
  })
})

describe('motion scripts', () => {
  it('builds one script per action from validated numbers', () => {
    expect(buildMotionScript('jog', jog)).toBe('G91\nG1 X10 F3000\nG90')
    expect(
      buildMotionScript('jog', { axis: 'z', distance_mm: -0.05, feed: 600 }),
    ).toBe('G91\nG1 Z-0.05 F600\nG90')
    expect(buildMotionScript('motors_off', {})).toBe('M84')
    expect(buildMotionScript('z_babystep', { delta_mm: 0.025 })).toBe(
      'SET_GCODE_OFFSET Z_ADJUST=0.025 MOVE=1',
    )
    expect(buildMotionScript('z_babystep', { delta_mm: -0.001 })).toBe(
      'SET_GCODE_OFFSET Z_ADJUST=-0.001 MOVE=1',
    )
    expect(
      buildMotionScript('set_factor', { speed_pct: 150, flow_pct: 95 }),
    ).toBe('M220 S150\nM221 S95')
  })
  it('refuses unvalidated arguments and never injects text', () => {
    for (const args of [
      { ...jog, axis: 'X\nM112' },
      { ...jog, distance_mm: '10' },
      { ...jog, feed: 3000.5 },
    ])
      expect(() => buildMotionScript('jog', args)).toThrow(MotionRefusal)
  })
  it('goes through the Moonraker command builder', () => {
    expect(buildMoonrakerCommand('jog', jog)).toEqual({
      method: 'printer.gcode.script',
      params: { script: 'G91\nG1 X10 F3000\nG90' },
    })
    expect(() => buildMoonrakerCommand('jog', { ...jog, x: 1 })).toThrow()
  })
  it('advertises motion only for a printer that lists a toolhead', () => {
    const motion = ['jog', 'motors_off', 'z_babystep', 'set_factor']
    expect(motionSupported(['toolhead'])).toBe(true)
    expect(motionSupported([])).toBe(false)
    expect(motionSupported(undefined)).toBe(false)
    expect(moonrakerControls(['extruder', 'toolhead'])).toEqual(
      expect.arrayContaining(motion),
    )
    for (const objects of [undefined, [], ['extruder', 'heater_bed']])
      for (const action of motion)
        expect(moonrakerControls(objects)).not.toContain(action)
  })
})

describe('motion refusals', () => {
  const refused = (
    action: 'jog' | 'motors_off',
    args: Record<string, unknown>,
    state: MotionState | undefined,
  ) => {
    try {
      refuseMotion(action, args, state)
    } catch (error) {
      return error instanceof MotionRefusal ? error.code : 'other'
    }
    return 'allowed'
  }
  it('allows a homed, idle, in-range jog and motors off', () => {
    expect(refused('jog', jog, idle)).toBe('allowed')
    expect(refused('jog', { ...jog, distance_mm: 120 - 100 }, idle)).toBe(
      'allowed',
    )
    expect(refused('motors_off', {}, idle)).toBe('allowed')
    expect(moonrakerMotionCommand('jog', jog, idle).params.script).toContain(
      'G1 X10',
    )
  })
  it('refuses while printing or paused', () => {
    for (const printState of ['printing', 'paused'] as const) {
      expect(refused('jog', jog, { ...idle, printState })).toBe('printing')
      expect(refused('motors_off', {}, { ...idle, printState })).toBe(
        'printing',
      )
    }
  })
  it('refuses an axis that is not homed', () => {
    expect(refused('jog', jog, { ...idle, homedAxes: '' })).toBe('unhomed')
    expect(refused('jog', jog, { ...idle, homedAxes: 'yz' })).toBe('unhomed')
    expect(
      refused('jog', { ...jog, axis: 'y' }, { ...idle, homedAxes: 'x' }),
    ).toBe('unhomed')
  })
  it('refuses a move past an axis limit', () => {
    expect(refused('jog', { ...jog, distance_mm: 100 }, idle)).toBe('allowed')
    expect(
      refused(
        'jog',
        { ...jog, distance_mm: 100 },
        { ...idle, position: [150, 0, 0, 0] },
      ),
    ).toBe('out-of-range')
    expect(
      refused(
        'jog',
        { ...jog, distance_mm: -0.01 },
        { ...idle, position: [0, 0, 0, 0] },
      ),
    ).toBe('out-of-range')
    expect(
      refused(
        'jog',
        { axis: 'z', distance_mm: 1, feed: 600 },
        { ...idle, position: [0, 0, 250, 0] },
      ),
    ).toBe('out-of-range')
  })
  it('refuses with no or unreadable state', () => {
    expect(refused('jog', jog, undefined)).toBe('unknown-state')
    expect(refused('jog', jog, { ...idle, ready: false })).toBe('unknown-state')
    expect(refused('jog', jog, { ...idle, printState: 'error' })).toBe(
      'unknown-state',
    )
    expect(() => parseMotionState({ eventtime: 1, status: {} })).toThrow(
      MotionRefusal,
    )
    expect(JSON.parse(motionQueryWire(11)).params.objects.toolhead).toContain(
      'homed_axes',
    )
  })
  it('lets babystep and factors run while printing', () => {
    expect(() =>
      refuseMotion(
        'z_babystep',
        { delta_mm: 0.01 },
        { ...idle, printState: 'printing' },
      ),
    ).not.toThrow()
    expect(() =>
      refuseMotion('set_factor', { speed_pct: 120, flow_pct: 100 }, undefined),
    ).not.toThrow()
  })
})

const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 500,
  requestTimeoutMs: 500,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
let monotonic = 0
const clock = { monotonicNow: () => (monotonic += 0.001) }

/** The E16 Moonraker mock on 127.0.0.1 with an ephemeral port. */
async function withMock<T>(
  options: MoonrakerMockOptions,
  run: (
    mock: Awaited<ReturnType<typeof startMoonrakerMock>>,
    attempt: (
      action: ExtendedControlAction,
      args: Record<string, unknown>,
    ) => Promise<{ ok: boolean; error?: unknown; guard: number }>,
  ) => Promise<T>,
): Promise<T> {
  // Start unhomed so every test homes first, as on a fresh boot.
  const mock = await startMoonrakerMock({ homedAxes: '', ...options })
  try {
    const registry = createPrinterBindingRegistry({
      allowedOrigins: [mock.origin],
    })
    const binding = registry.provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'printer-motion',
      moonraker_origin: mock.origin,
    })
    const objects = (
      await import('../../packages/connector/src/moonraker/control-support.ts')
    ).detectMoonrakerObjects
    const detected = await objects({
      binding,
      allowedOrigins: [mock.origin],
      limits,
      signal: new AbortController().signal,
    })
    const attempt = async (
      action: ExtendedControlAction,
      args: Record<string, unknown>,
    ) => {
      const owner = new AbortController()
      let guard = 0
      const fixed = openFixedMoonrakerPause({
        binding,
        allowedOrigins: [mock.origin],
        limits,
        connectionGeneration: 1,
        clock,
        publish: () => {},
        signal: owner.signal,
        objects: detected,
      })
      try {
        await fixed.prepare()
        await fixed.driver.execute!(action, args, {
          binding,
          beforeSend: () => {
            guard++
            return true
          },
          signal: owner.signal,
        })
        return { ok: true, guard }
      } catch (error) {
        return { ok: false, error, guard }
      } finally {
        await fixed.close()
      }
    }
    return await run(mock, attempt)
  } finally {
    await mock.close()
  }
}

async function position(origin: string) {
  const reply = (await (
    await fetch(`${origin}/printer/objects/query?toolhead=position`)
  ).json()) as { result: { status: { toolhead: { position: number[] } } } }
  return reply.result.status.toolhead.position.slice(0, 3)
}

describe('Moonraker motion driver on the E16 mock', () => {
  it('homes, jogs in one script and releases the motors', async () => {
    await withMock({}, async (mock, attempt) => {
      expect((await attempt('home', { axes: ['x', 'y', 'z'] })).ok).toBe(true)
      expect(await position(mock.origin)).toEqual([0, 0, 0])
      const moved = await attempt('jog', {
        axis: 'x',
        distance_mm: 12.5,
        feed: 3000,
      })
      expect(moved).toMatchObject({ ok: true, guard: 1 })
      expect(mock.control.gcodeScripts.at(-1)).toBe('G91\nG1 X12.5 F3000\nG90')
      expect(await position(mock.origin)).toEqual([12.5, 0, 0])
      expect((await attempt('motors_off', {})).ok).toBe(true)
      expect(mock.control.gcodeScripts.at(-1)).toBe('M84')
    })
  })

  it('sends z_babystep and set_factor, also while printing', async () => {
    await withMock(
      { initial: { state: 'printing' } },
      async (mock, attempt) => {
        expect((await attempt('z_babystep', { delta_mm: -0.025 })).ok).toBe(
          true,
        )
        expect(mock.control.gcodeScripts).toEqual([
          'SET_GCODE_OFFSET Z_ADJUST=-0.025 MOVE=1',
        ])
        expect(
          (await attempt('set_factor', { speed_pct: 120, flow_pct: 95 })).ok,
        ).toBe(true)
        expect(mock.control.gcodeScripts.at(-1)).toBe('M220 S120\nM221 S95')
        expect(mock.control.model().speedFactor).toBe(1.2)
      },
    )
  })

  it('refuses jog unhomed and writes nothing', async () => {
    await withMock({}, async (mock, attempt) => {
      const result = await attempt('jog', jog)
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as MotionRefusal).code).toBe('unhomed')
      expect(mock.control.gcodeScripts).toEqual([])
    })
  })

  it.each(['printing', 'paused'] as const)(
    'refuses jog and motors_off while %s',
    async (state) => {
      await withMock({ initial: { state } }, async (mock, attempt) => {
        for (const [action, args] of [
          ['jog', jog],
          ['motors_off', {}],
        ] as const) {
          const result = await attempt(action, args)
          expect(result).toMatchObject({ ok: false, guard: 0 })
          expect((result.error as MotionRefusal).code).toBe('printing')
        }
        expect(mock.control.gcodeScripts).toEqual([])
      })
    },
  )

  it('refuses a jog past the axis limit', async () => {
    await withMock({}, async (mock, attempt) => {
      await attempt('home', { axes: ['x', 'y', 'z'] })
      const before = mock.control.gcodeScripts.length
      const result = await attempt('jog', {
        axis: 'x',
        distance_mm: -0.01,
        feed: 3000,
      })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as MotionRefusal).code).toBe('out-of-range')
      expect(mock.control.gcodeScripts).toHaveLength(before)
      expect(await position(mock.origin)).toEqual([0, 0, 0])
    })
  })

  it('refuses every motion action on a printer that lists no toolhead', async () => {
    await withMock(
      { objects: ['webhooks', 'print_stats', 'extruder'] },
      async (mock, attempt) => {
        for (const [action, args] of [
          ['jog', jog],
          ['motors_off', {}],
          ['z_babystep', { delta_mm: 0.01 }],
          ['set_factor', { speed_pct: 100, flow_pct: 100 }],
        ] as const) {
          const result = await attempt(action, args)
          expect(result).toMatchObject({ ok: false, guard: 0 })
          expect((result.error as MotionRefusal).code).toBe('unsupported')
        }
        expect(mock.control.gcodeScripts).toEqual([])
      },
    )
  })

  it('refuses malformed arguments before any read or write', async () => {
    await withMock({}, async (mock, attempt) => {
      const result = await attempt('jog', { ...jog, distance_mm: 500 })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect(mock.control.gcodeScripts).toEqual([])
    })
  })
})

const everything = Object.fromEntries(
  ['home', 'jog', 'motors_off', 'z_babystep', 'set_factor'].map((control) => [
    control,
    { available: true },
  ]),
)
const off = (reason: string) =>
  Object.fromEntries(
    Object.keys(everything).map((control) => [
      control,
      { available: false, reason },
    ]),
  )

describe('MotionPanel', () => {
  const file = '../printer-detail/MotionPanel.vue'
  const base = {
    availability: everything,
    position: [10.25, 20, 5.5],
    homedAxes: ['x', 'y', 'z'],
    factors: true,
  }
  it('shows the position readout, step selector and a labelled pad', async () => {
    const html = await renderFarmComponent(file, base)
    for (const text of [
      'Movimento',
      'X: 10,25 mm',
      'Y: 20 mm',
      'Z: 5,5 mm',
      'Passo de movimento',
      'X+: mover para a direita',
      'X−: mover para a esquerda',
      'Y+: mover para trás',
      'Y−: mover para frente',
      'Z+: mover para cima',
      'Z−: mover para baixo',
      'Referenciar eixos',
      'Desligar motores',
      'Ajuste fino do Z',
      'Velocidade (%)',
      'Fluxo (%)',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('disabled')
  })
  it('says why commands are off and which axes are not homed', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      availability: off('Comando indisponível. A impressora está imprimindo.'),
      homedAxes: ['x'],
    })
    expect(html.match(/A impressora está imprimindo\./g)).toHaveLength(1)
    expect(html).toContain('Não referenciado: Y, Z.')
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(12)
  })
  it('keeps babystep and factors on while jogging is refused', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      availability: {
        ...everything,
        jog: { available: false, reason: 'Comando indisponível.' },
      },
    })
    expect(html.match(/disabled/g)).toHaveLength(6)
  })
  it('only enables the jog pad for homed axes', async () => {
    const html = await renderFarmComponent(file, { ...base, homedAxes: ['x'] })
    expect(html.match(/disabled/g)).toHaveLength(4)
  })
  it('reports an unavailable position without inventing one', async () => {
    const html = await renderFarmComponent(file, {
      availability: everything,
      homedAxes: [],
    })
    expect(html).toContain('X: Indisponível')
    expect(html).toContain('Esta impressora não anuncia este recurso.')
  })
})

describe('motion panel rules', () => {
  it('signs the jog by direction and only offers listed steps', () => {
    expect(jogRequest(1, '10', '3000')).toEqual({ distanceMm: 10, feed: 3000 })
    expect(jogRequest(-1, '0.1', 600)).toEqual({ distanceMm: -0.1, feed: 600 })
    expect(jogRequest(1, '7', '3000')).toBeUndefined()
    expect(jogRequest(1, '10', '1')).toBeUndefined()
    expect(babystepDelta(-1, '0.005')).toBe(-0.005)
    expect(babystepDelta(1, '0.05')).toBe(0.05)
    expect(babystepDelta(1, '0.2')).toBeUndefined()
    for (const sign of [1, -1] as const) {
      for (const step of [0.1, 1, 10, 100])
        expect(
          ControlArguments.safeParse({
            action: 'jog',
            args: {
              axis: 'x',
              distance_mm: jogRequest(sign, step, 600)?.distanceMm,
              feed: 600,
            },
          }).success,
        ).toBe(true)
      for (const size of [0.005, 0.01, 0.025, 0.05])
        expect(
          ControlArguments.safeParse({
            action: 'z_babystep',
            args: { delta_mm: babystepDelta(sign, size) },
          }).success,
        ).toBe(true)
    }
  })
  it('validates speed and flow with a pt-BR note', () => {
    expect(factorRequest('150', 95)).toEqual({ speedPct: 150, flowPct: 95 })
    expect(factorRequest('9', '100')).toEqual({
      note: 'Informe a velocidade como número inteiro entre 10 e 300 %.',
    })
    expect(factorRequest('100', '151')).toEqual({
      note: 'Informe o fluxo como número inteiro entre 50 e 150 %.',
    })
    expect(factorRequest('', '100')).toHaveProperty('note')
    expect(factorRequest('100.5', '100')).toHaveProperty('note')
  })
  it('formats the readout and finds unhomed axes', () => {
    expect(positionText('x', [1.5, 2, 3])).toBe('X: 1,5 mm')
    expect(positionText('z', undefined)).toBe('Z: Indisponível')
    expect(unhomedAxes(['x'])).toEqual(['y', 'z'])
    expect(unhomedAxes(undefined)).toEqual([])
  })
})

describe('MotionPanel keyboard and layout', () => {
  it('passes axe, fits and is operable by keyboard at 320, 768 and 1280 px', async () => {
    const html = await renderFarmComponent(
      '../printer-detail/MotionPanel.vue',
      {
        availability: everything,
        position: [10, 20, 5],
        homedAxes: ['x', 'y', 'z'],
        factors: true,
      },
    )
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const styles = async (paths: string[]) =>
      (
        await Promise.all(
          paths.map(async (path) =>
            parse(await read(path)).descriptor.styles.map((s) => s.content),
          ),
        )
      )
        .flat()
        .join('\n')
    const css = `${await read('../../apps/farm/app/assets/tokens/tokens.css')}\n${await read('../../apps/farm/app/assets/css/main.css')}\n${await styles(
      [
        '../../apps/farm/app/components/printer-detail/MotionPanel.vue',
        '../../apps/farm/app/components/ui/Button.vue',
      ],
    )}`
    const server = await startHttpMock({
      port: 0,
      routes: {
        '/': (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Movimento</title><style>${css}</style><main><h1>Impressora</h1>${html}</main></html>`,
          )
        },
      },
    })
    try {
      const browser = await launchBrowser({
        args: ['--disable-background-networking'],
      })
      try {
        const page = await (await browser.newContext()).newPage()
        await page.route('**/*', (route) =>
          new URL(route.request().url()).origin === server.origin
            ? route.continue()
            : route.abort(),
        )
        for (const width of [320, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 })
          expect((await page.goto(server.origin))?.ok()).toBe(true)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(width)
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
            [],
          )
          // Arrow keys move the step selection inside the radio group.
          await page.getByLabel('1 mm', { exact: true }).focus()
          await page.keyboard.press('ArrowRight')
          expect(
            await page.getByLabel('10 mm', { exact: true }).isChecked(),
          ).toBe(true)
          // Tab walks the pad in order; Enter and Space activate a button.
          await page.evaluate(() => {
            const log: string[] = []
            Object.assign(window, { clicks: log })
            document.addEventListener('click', (event) =>
              log.push((event.target as HTMLElement).textContent ?? ''),
            )
          })
          const names = [
            'X−: mover para a esquerda',
            'X+: mover para a direita',
            'Y−: mover para frente',
            'Y+: mover para trás',
            'Z−: mover para baixo',
            'Z+: mover para cima',
          ]
          await page.getByRole('button', { name: names[0]! }).focus()
          for (const name of names.slice(1)) {
            await page.keyboard.press('Tab')
            expect(
              await page.evaluate(() =>
                document.activeElement?.getAttribute('aria-label'),
              ),
            ).toBe(name)
          }
          await page.getByRole('button', { name: names[1]! }).focus()
          await page.keyboard.press('Enter')
          await page.keyboard.press('Space')
          expect(
            await page.evaluate(
              () => (window as unknown as { clicks: string[] }).clicks,
            ),
          ).toEqual(['X+', 'X+'])
        }
      } finally {
        await browser.close()
      }
    } finally {
      await server.close()
    }
  }, 120_000)
})

describe('command journal', () => {
  it('migrates a v4 journal and records the motion actions', () => {
    // Scratch directory under the OS temp area; left in place on purpose.
    const directory = mkdtempSync(join(tmpdir(), 'motion-journal-'))
    closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
    const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      db.exec(
        "DROP TABLE control_command_actions; CREATE TABLE control_command_actions (cmd_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel','emergency_stop','firmware_restart','run_macro','load_filament','unload_filament','set_temperature','set_fan','home','set_light','set_speed','start_print'))) STRICT; INSERT INTO control_command_actions VALUES ('retained', 'run_macro'); PRAGMA user_version=4;",
      )
    } finally {
      db.close()
    }
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      expect(readCommandAction(journal, 'retained')).toBe('run_macro')
    } finally {
      closeCommandJournal(journal)
    }
    const migrated = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      for (const action of ['jog', 'motors_off', 'z_babystep', 'set_factor'])
        migrated
          .prepare('INSERT INTO control_command_actions VALUES (?,?)')
          .run(action, action)
      expect(() =>
        migrated.exec(
          "INSERT INTO control_command_actions VALUES ('invalid', 'invalid')",
        ),
      ).toThrow()
    } finally {
      migrated.close()
    }
  })
})
