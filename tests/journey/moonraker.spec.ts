import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  journeyEnabled,
  reportedPrintProgressBar,
  reportedProgressValue,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

const FILE = 'journey.gcode'

if (journeyEnabled())
  test.describe('journey: Moonraker', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(5 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'moonraker-fixture',
        openFarmInspector: true,
        history: true,
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('acompanha a jornada Moonraker e registra a conclusão', async () => {
      test.setTimeout(5 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      try {
        await journey.expectLiveTelemetry()
        // expectLiveTelemetry opened /farm; keep its live connection.
        const row = journey.farmRow()
        await expect(row).toContainText('Conexão direta autenticada')
        await expect(reportedPrintProgressBar(row)).toHaveAttribute(
          'aria-valuenow',
          reportedProgressValue(0.25),
        )
        await expect(row.getByLabel('Temperaturas observadas')).toContainText(
          '210 °C',
        )

        journey.advanceSimulator()
        await journey.expectProgress(0.75)
        journey.controls.finishPrint()
        await expect(row.getByText('Concluído', { exact: true })).toBeVisible({
          timeout: 60_000,
        })
        await expect(row.getByLabel('Último trabalho')).toContainText(FILE)
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })

        journey.setTelemetryUpload(true)
        try {
          await page.goto(journey.origin + '/historico', {
            waitUntil: 'domcontentloaded',
          })
          await expect(
            page.getByRole('heading', { name: 'Histórico de trabalhos' }),
          ).toBeVisible()
          const entry = page
            .getByRole('table', { name: 'Trabalhos finalizados' })
            .getByRole('row')
            .filter({ hasText: FILE })
            .filter({ hasText: 'Concluído' })
          await expect(async () => {
            await page
              .getByRole('button', { name: 'Atualizar histórico' })
              .click()
            await expect(entry).toHaveCount(1, { timeout: 3000 })
          }).toPass({ timeout: 90_000 })
          await expect(
            entry.getByRole('cell', { name: journey.printerKey, exact: true }),
          ).toBeVisible()
        } finally {
          journey.setTelemetryUpload(false)
        }
      } catch (error) {
        console.error(
          JSON.stringify(journey.simulatorObservation()),
          journey.appLog(),
        )
        throw error
      }
    })
  })

if (journeyEnabled())
  test('mostra a temperatura do bico ativo da Snapmaker U1 simulada', async ({
    browser,
  }) => {
    test.setTimeout(5 * 60_000)
    const journey = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
      openFarmInspector: true,
      moonraker: { mock: { profile: 'u1' } },
    })
    try {
      const printer = journey.printer.control
      printer.update({
        activeExtruder: 'extruder2',
        extruders: {
          extruder2: { temperature: 230, target: 235 },
          extruder3: { temperature: 245, target: 250 },
        },
      })

      await journey.expectLiveTelemetry()
      expect(journey.printer.subscriptionObjects()).toContainEqual(
        expect.objectContaining({
          extruder1: ['temperature', 'target'],
          extruder2: ['temperature', 'target'],
          extruder3: ['temperature', 'target'],
          toolhead: ['extruder'],
        }),
      )
      const row = journey.farmRow()
      const temperatures = row.getByLabel('Temperaturas observadas')
      await expect(temperatures).toContainText('230 °C')
      await expect(temperatures).toContainText('60 °C')

      printer.update({ activeExtruder: 'extruder3' })
      await expect(temperatures).toContainText('245 °C')

      printer.update({ activeExtruder: 'extruder' })
      await expect(temperatures).toContainText('210 °C')

      printer.update({ activeExtruder: 'extruder9' })
      await expect(temperatures).toContainText('Indisponível')
      await expect(temperatures).toContainText('60 °C')
      await journey.expectProgress(0.25)
      expect(printer.gcodeScripts).toEqual([])
    } finally {
      await journey.close()
    }
  })

// Authorized direct WebRTC lifecycle commands against the loopback Moonraker
// fixture. Every command is signed in the browser and travels over its own
// direct connection; nothing here calls the fixture's RPC surface. The fixture
// records what reaches it, so each assertion pairs the page outcome with the
// exact `printer.print.*` call count and an empty G-code log.
const NOT_SENT = /Nenhum comando foi enviado\./
const RESULT = {
  pause: 'Impressão pausada. O Connector confirmou a pausa.',
  resume: 'Impressão retomada. O Connector confirmou a retomada.',
  cancel: 'Impressão cancelada. O Connector confirmou o cancelamento.',
} as const
const PRINT_CALLS = [
  'printer.print.start',
  'printer.print.pause',
  'printer.print.resume',
  'printer.print.cancel',
  'printer.emergency_stop',
  'printer.gcode.script',
] as const

if (journeyEnabled())
  test.describe('journey: Moonraker lifecycle controls', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    const printerRow = (page: Page) => started().farmRow(page)
    const controls = (page: Page) =>
      printerRow(page).getByRole('group', {
        name: 'Controles da impressora ' + started().printerKey,
      })
    const button = (page: Page, label: string) =>
      controls(page).getByRole('button', { name: label, exact: true })
    const reportedState = (row: Locator, label: string) =>
      expect(
        row
          .locator('dt', { hasText: 'Último estado informado' })
          .locator('+ dd'),
      ).toHaveText(label, { timeout: 30_000 })
    /** Fixture RPC counts for every state-changing or G-code method. */
    const written = () => {
      const calls = started().printer.calls()
      return Object.fromEntries(
        PRINT_CALLS.map((method) => [method, calls[method] ?? 0]),
      )
    }

    // Each signed command consumes one control session of the Connector, which
    // then needs a moment to listen again; an early attempt fails closed with
    // nothing sent, so the journey waits for a fresh control inbox first.
    let inboxesUsed = 0
    async function controlInbox() {
      const observe = () => started().simulatorObservation()
      await expect
        .poll(
          () => {
            const { pauseInboxReady, pauseInboxes } = observe()
            return pauseInboxReady && pauseInboxes > inboxesUsed
          },
          { timeout: 90_000 },
        )
        .toBe(true)
      inboxesUsed = observe().pauseInboxes
    }

    async function lifecycle(
      page: Page,
      action: keyof typeof RESULT,
      label: string,
      confirm: string,
    ) {
      // The command dialog is titled with the printer; the inspector is not.
      const dialog = page.getByRole('dialog', {
        name: new RegExp(started().printerKey),
      })
      const status = dialog.getByRole('status')
      const confirmation = dialog.getByRole('button', {
        name: confirm,
        exact: true,
      })
      for (let attempt = 1; ; attempt++) {
        await controlInbox()
        await expect(button(page, label)).toHaveAttribute(
          'aria-disabled',
          'false',
          { timeout: 20_000 },
        )
        await button(page, label).click()
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
        await dialog
          .getByRole('button', { name: 'Fechar', exact: true })
          .click()
        await expect(dialog).toBeHidden()
      }
      await confirmation.click()
      await expect(status).toHaveText(RESULT[action], { timeout: 45_000 })
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
      await expect(dialog).toBeHidden()
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(5 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'moonraker-fixture',
        openFarmInspector: true,
        signedControl: true,
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('idle printer: lifecycle commands are unavailable and nothing is sent', async () => {
      test.setTimeout(3 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      await journey.expectLiveTelemetry()
      const row = printerRow(page)
      await expect(row).toContainText('Conexão direta autenticada')
      // Safe idle: the printer reports standby, so no lifecycle command applies.
      journey.printer.update({ state: 'standby', progress: 0 })
      await reportedState(row, 'Ociosa')
      await expect(controls(page)).toBeVisible({ timeout: 60_000 })
      for (const [label, why] of [
        ['Pausar', 'A impressora não está imprimindo.'],
        ['Retomar', 'A impressão não está pausada.'],
        ['Cancelar', 'A impressora não está imprimindo nem pausada.'],
      ] as const) {
        const control = button(page, label)
        await expect(control).toHaveAttribute('aria-disabled', 'true')
        await expect(controls(page)).toContainText(why)
      }
      expect(written()).toEqual(
        Object.fromEntries(PRINT_CALLS.map((method) => [method, 0])),
      )
      expect(journey.printer.control.gcodeScripts).toEqual([])
    })

    test('printing: pause and cancel are offered; pause and resume reach the fixture once', async () => {
      test.setTimeout(5 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      const row = printerRow(page)
      journey.printer.update({ state: 'printing', progress: 0.25 })
      await reportedState(row, 'Imprimindo')
      await expect(button(page, 'Pausar')).toHaveAttribute(
        'aria-disabled',
        'false',
        { timeout: 30_000 },
      )
      await expect(button(page, 'Retomar')).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      await expect(button(page, 'Cancelar')).toHaveAttribute(
        'aria-disabled',
        'false',
      )

      await lifecycle(page, 'pause', 'Pausar', 'Confirmar pausa')
      expect(journey.printer.model().state).toBe('paused')
      expect(written()).toMatchObject({
        'printer.print.pause': 1,
        'printer.print.resume': 0,
        'printer.print.cancel': 0,
      })
      await reportedState(row, 'Pausada')
      await expect(button(page, 'Pausar')).toHaveAttribute(
        'aria-disabled',
        'true',
      )

      await lifecycle(page, 'resume', 'Retomar', 'Confirmar retomada')
      expect(journey.printer.model().state).toBe('printing')
      expect(written()).toMatchObject({
        'printer.print.pause': 1,
        'printer.print.resume': 1,
        'printer.print.cancel': 0,
      })
      await reportedState(row, 'Imprimindo')
    })

    test('cancel ends the job and nothing else is written', async () => {
      test.setTimeout(5 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      const row = printerRow(page)
      await lifecycle(page, 'cancel', 'Cancelar', 'Confirmar cancelamento')
      expect(journey.printer.model().state).toBe('cancelled')
      expect(written()).toEqual({
        'printer.print.start': 0,
        'printer.print.pause': 1,
        'printer.print.resume': 1,
        'printer.print.cancel': 1,
        'printer.emergency_stop': 0,
        'printer.gcode.script': 0,
      })
      expect(journey.printer.control.gcodeScripts).toEqual([])
      await expect(row.getByText('Cancelado', { exact: true })).toBeVisible({
        timeout: 60_000,
      })
      // A cancelled job leaves the printer idle: every lifecycle command is
      // unavailable again.
      for (const label of ['Pausar', 'Retomar', 'Cancelar'])
        await expect(button(page, label)).toHaveAttribute(
          'aria-disabled',
          'true',
          { timeout: 30_000 },
        )
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })
    })
  })

// A locally declared Snapmaker U1 advertises no command (every one is
// unsupported: tool commands have no builder, generic Klipper writes are not
// qualified on U1 hardware), so the page offers no control and the Connector
// writes nothing, even though the signed control path is open.
if (journeyEnabled())
  test('Snapmaker U1 declarada: nenhum comando é oferecido nem enviado', async ({
    browser,
  }) => {
    test.setTimeout(5 * 60_000)
    const journey = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
      openFarmInspector: true,
      signedControl: true,
      moonraker: { mock: { profile: 'u1' }, declaredModel: 'Snapmaker U1' },
    })
    try {
      const page = journey.ownerPage
      await journey.expectLiveTelemetry()
      const row = journey.farmRow()
      await expect(row).toContainText('Conexão direta autenticada')
      await journey.expectProgress(0.25)
      // The control inbox opens: control is armed, yet no command is offered.
      await expect
        .poll(() => journey.simulatorObservation().pauseInboxReady, {
          timeout: 90_000,
        })
        .toBe(true)
      await expect(
        row.getByRole('group', {
          name: 'Controles da impressora ' + journey.printerKey,
        }),
      ).toHaveCount(0)
      for (const label of ['Pausar', 'Retomar', 'Cancelar'])
        await expect(
          row.getByRole('button', { name: label, exact: true }),
        ).toHaveCount(0)
      await expect(
        page.getByRole('region', {
          name: 'Controles adicionais de ' + journey.printerKey,
        }),
      ).toHaveCount(0)
      expect(
        Object.fromEntries(
          PRINT_CALLS.map((method) => [
            method,
            journey.printer.calls()[method] ?? 0,
          ]),
        ),
      ).toEqual(Object.fromEntries(PRINT_CALLS.map((method) => [method, 0])))
      expect(journey.printer.control.gcodeScripts).toEqual([])
      expect(journey.printer.model().state).toBe('printing')
    } finally {
      await journey.close()
    }
  })
