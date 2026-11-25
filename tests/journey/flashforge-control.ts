// Flashforge command binding in the browser, against the original synthetic
// simulator. The shipped write qualification list is empty: the first journey
// runs the shipped build; the others edit it for this run only.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { commandDialog, inspectPrinter } from './creality-inspector.ts'
import { expectCameraFrames } from './discovery-page.ts'
import type { startFlashforgeControlFixture } from './flashforge-control-fixture.ts'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

const COMMANDS =
  /pausar|retomar|cancelar|iniciar impressão|definir|carregar|controlar transmissão|salvar material/i
const NOT_SENT = /Nenhum comando foi enviado\./
const CONFIRMED = /^Comando confirmado pelo Connector\./

type Fixture = Awaited<ReturnType<typeof startFlashforgeControlFixture>>

/** One signed command per Connector control session, as the operator does. */
function operator(journey: JourneyHarness) {
  const page: Page = journey.ownerPage
  let inboxesUsed = 0
  async function command(
    open: () => Promise<void>,
    button: string,
    outcome: string | RegExp,
  ) {
    const dialog = commandDialog(journey, page)
    const status = dialog.getByRole('status')
    const confirmation = dialog.getByRole('button', {
      name: button,
      exact: true,
    })
    for (let attempt = 1; ; attempt++) {
      await expect
        .poll(
          () => {
            const seen = journey.simulatorObservation()
            return seen.pauseInboxReady && seen.pauseInboxes > inboxesUsed
          },
          { timeout: 90_000 },
        )
        .toBe(true)
      inboxesUsed = journey.simulatorObservation().pauseInboxes
      await open()
      await expect(dialog).toBeVisible()
      await expect(async () => {
        expect(
          (await confirmation.isEnabled()) ||
            NOT_SENT.test((await status.textContent()) ?? ''),
        ).toBe(true)
      }).toPass({ timeout: 45_000 })
      if (await confirmation.isEnabled()) break
      // Fail-closed before any send: nothing reached the printer.
      expect(attempt, (await status.textContent()) ?? '').toBeLessThan(4)
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
      await expect(dialog).toBeHidden()
    }
    await confirmation.click()
    await expect(status).toHaveText(outcome, { timeout: 45_000 })
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  return {
    lifecycle(row: Locator, label: string, button: string, outcome: string) {
      const control = row
        .getByRole('group', {
          name: 'Controles da impressora ' + journey.printerKey,
        })
        .getByRole('button', { name: label, exact: true })
      return command(
        async () => {
          await expect(control).toHaveAttribute('aria-disabled', 'false', {
            timeout: 20_000,
          })
          await control.click()
        },
        button,
        outcome,
      )
    },
    /** One form of "Controles adicionais", filled and then signed. */
    extended(
      row: Locator,
      label: string,
      fill: (block: Locator) => Promise<unknown>,
      outcome: string | RegExp = CONFIRMED,
    ) {
      const block = row
        .getByRole('region', {
          name: 'Controles adicionais de ' + journey.printerKey,
        })
        .locator('div.control')
        .filter({
          has: row.page().getByRole('button', { name: label, exact: true }),
        })
      const control = block.getByRole('button', { name: label, exact: true })
      return command(
        async () => {
          await fill(block)
          await expect(control).toBeEnabled({ timeout: 20_000 })
          await control.click()
        },
        'Confirmar comando',
        outcome,
      )
    },
    /** Loads one AD5X station slot from the filament controls. */
    load(row: Locator, tray: string) {
      const section = row.getByRole('region', {
        name: 'Macros e filamento de ' + journey.printerKey,
      })
      const control = section.getByRole('button', {
        name: 'Carregar filamento',
        exact: true,
      })
      return command(
        async () => {
          await section.locator('select').selectOption(tray)
          await expect(control).toBeEnabled({ timeout: 20_000 })
          await control.click()
        },
        'Confirmar comando',
        CONFIRMED,
      )
    },
  }
}

async function open(journey: JourneyHarness) {
  const row = await inspectPrinter(journey)
  await expect(
    row.getByText('Conexão direta autenticada', { exact: true }),
  ).toBeVisible({ timeout: 90_000 })
  await expect(row).toContainText('Imprimindo', { timeout: 30_000 })
  return row
}

const reported = (row: Locator, state: string) =>
  expect(row).toContainText(state, { timeout: 30_000 })

const control = (cmd: string, args: object) => ({
  path: '/control',
  payload: { cmd, args },
})
const job = (action: string) => control('jobCtl_cmd', { jobID: '', action })

async function withJourney(
  options: Omit<Parameters<typeof startJourneyHarness>[0], 'simulator'>,
  run: (journey: JourneyHarness, fixture: Fixture) => Promise<void>,
) {
  const journey = await startJourneyHarness({
    ...options,
    simulator: 'flashforge',
    control: true,
    signedControl: true,
    // The issuer grants only controls the Connector recently advertised.
    history: true,
  })
  const fixture = journey.vendor?.raw as Fixture
  try {
    await run(journey, fixture)
  } catch (error) {
    console.error(
      JSON.stringify(journey.simulatorObservation()),
      JSON.stringify(fixture.sim.writes),
      journey.appLog(),
    )
    throw error
  } finally {
    await journey.close()
  }
}

export function flashforgeControlJourneys() {
  if (!journeyEnabled()) return

  test('flashforge: unqualified writes are not offered and the camera plays', async ({
    browser,
  }) => {
    await withJourney({ browser }, async (journey, fixture) => {
      const row = await open(journey)
      await expect
        .poll(() => journey.simulatorObservation().pauseInboxReady, {
          timeout: 90_000,
        })
        .toBe(true)
      expect(await journey.advertisedControls()).toEqual([])
      const inspector = journey.ownerPage.getByRole('dialog', {
        name: 'Inspeção da impressora',
      })
      await expect(row.getByRole('button', { name: COMMANDS })).toHaveCount(0)
      await expect(
        inspector.getByRole('button', { name: COMMANDS }),
      ).toHaveCount(0)
      await expectCameraFrames(journey)
      expect(fixture.sim.writes).toEqual([])
      expect(new Set(fixture.sim.requests)).toEqual(new Set(['POST /detail']))
    })
  })

  test('flashforge: qualified 5M Pro applies signed commands once each', async ({
    browser,
  }) => {
    await withJourney(
      { browser, flashforgeQualified: true },
      async (journey, fixture) => {
        const row = await open(journey)
        const { sim } = fixture
        const send = operator(journey)
        await send.lifecycle(
          row,
          'Pausar',
          'Confirmar pausa',
          'Impressão pausada. O Connector confirmou a pausa.',
        )
        await reported(row, 'Pausada')
        await send.lifecycle(
          row,
          'Retomar',
          'Confirmar retomada',
          'Impressão retomada. O Connector confirmou a retomada.',
        )
        await reported(row, 'Imprimindo')
        const set = (label: string, choice: string, value: string) =>
          send.extended(row, label, async (block) => {
            await block.locator('select').selectOption(choice)
            await block.locator('input').fill(value)
          })
        await set('Definir temperatura', 'extruder', '200')
        expect(sim.detail.rightTargetTemp).toBe(200)
        await set('Definir temperatura', 'bed', '65')
        expect(sim.detail.platTargetTemp).toBe(65)
        await set('Definir ventilador', 'part', '40')
        expect(sim.detail.coolingFanSpeed).toBe(40)
        const camera = (choice: string) =>
          send.extended(row, 'Controlar transmissão da câmera', (block) =>
            block.locator('select').selectOption(choice),
          )
        await camera('off')
        expect(sim.detail.cameraStreamUrl).toBe('')
        await camera('on')
        expect(sim.detail.cameraStreamUrl).not.toBe('')
        await send.lifecycle(
          row,
          'Cancelar',
          'Confirmar cancelamento',
          'Impressão cancelada. O Connector confirmou o cancelamento.',
        )
        await reported(row, 'Ociosa')
        expect(sim.writes).toEqual([
          job('pause'),
          job('continue'),
          control('temperatureCtl_cmd', { rightNozzle: 200 }),
          control('temperatureCtl_cmd', { platform: 65 }),
          control('printerCtl_cmd', { coolingFan: 40 }),
          control('streamCtrl_cmd', { action: 'close' }),
          control('streamCtrl_cmd', { action: 'open' }),
          job('cancel'),
        ])
      },
    )
  })

  test('flashforge: qualified AD5X applies lifecycle, slot record and slot load', async ({
    browser,
  }) => {
    await withJourney(
      { browser, flashforgeQualified: true, printerModel: 'AD5X' },
      async (journey, fixture) => {
        const row = await open(journey)
        const send = operator(journey)
        await send.lifecycle(
          row,
          'Pausar',
          'Confirmar pausa',
          'Impressão pausada. O Connector confirmou a pausa.',
        )
        await reported(row, 'Pausada')
        await send.lifecycle(
          row,
          'Cancelar',
          'Confirmar cancelamento',
          'Impressão cancelada. O Connector confirmou o cancelamento.',
        )
        await reported(row, 'Ociosa')
        // The operator clears the cancelled job on the touchscreen.
        fixture.sim.detail.status = 'ready'
        const slotLabel = 'Salvar material do compartimento'
        const fillSlot = async (block: Locator) => {
          await block.locator('select').nth(0).selectOption('2')
          await block.locator('select').nth(1).selectOption('PETG')
          await block.locator('input[type="color"]').fill('#11aa33')
        }
        await send.extended(row, slotLabel, fillSlot)
        await expect(row).toContainText('PETG', { timeout: 30_000 })
        await send.extended(
          row,
          slotLabel,
          fillSlot,
          'A impressora não está em um estado que aceite este comando.',
        )
        await send.load(row, '1')
        expect(fixture.sim.writes).toEqual([
          job('pause'),
          job('cancel'),
          control('msConfig_cmd', { slot: 3, mt: 'PETG', rgb: '11AA33' }),
          control('ms_cmd', { slot: 2, action: 0 }),
        ])
      },
    )
  })
}
