import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import {
  ANYCUBIC_QUALIFIED_WRITES,
  anycubicLanModel,
} from '../../packages/connector/src/anycubic/models.ts'
import type { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { openFarmInspector } from '../helpers/farm-inspector.ts'
import {
  journeyEnabled,
  reportedProgress,
  reportedProgressValue,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. Kobra 4 and Kobra S1 Max against the loopback
// simulator, never a physical printer. The shipped write list is empty; the
// qualification used by the second test exists only in
// tests/helpers/anycubic-qualified-connector.ts.
// There is no journey for "Kobra 3 Max V2": no source gives its LAN model id.

type Simulator = Awaited<ReturnType<typeof startAnycubicSimulator>>
const CONTROLS = /^(Pausar|Retomar|Cancelar|Iniciar impressão|Definir )/

const simulator = (journey: JourneyHarness) => journey.vendor!.raw as Simulator

function card(journey: JourneyHarness) {
  return journey.ownerPage
    .getByRole('dialog', { name: 'Inspeção da impressora', exact: true })
    .getByRole('article')
    .filter({
      has: journey.ownerPage.getByRole('heading', {
        name: journey.printerKey,
        exact: true,
      }),
    })
}

async function openCard(journey: JourneyHarness) {
  await journey.openFarm()
  await openFarmInspector(journey.ownerPage, journey.printerKey)
}

const connected = (journey: JourneyHarness) =>
  card(journey).getByText('Conexão direta autenticada', { exact: true })

/** The direct session is renewed; reload when it does not come back. */
async function expectCard(journey: JourneyHarness, check: () => Promise<void>) {
  await expect(async () => {
    if (!(await connected(journey).isVisible())) await openCard(journey)
    await expect(connected(journey)).toBeVisible({ timeout: 45_000 })
    await check()
  }).toPass({ timeout: 180_000 })
}

const expectState = (journey: JourneyHarness, label: string) =>
  expectCard(journey, async () => {
    await expect(
      card(journey)
        .getByText('Último estado informado', { exact: true })
        .locator('xpath=following-sibling::dd[1]'),
    ).toHaveText(label, { timeout: 15_000 })
  })

if (journeyEnabled())
  for (const modelId of ['20028', '20029'] as const) {
    const name = anycubicLanModel(modelId)!.name
    const chamberLight = anycubicLanModel(modelId)!.chamberLight

    test(`${name}: status is lost and recovers, with no control`, async ({
      browser,
    }) => {
      test.setTimeout(10 * 60_000)
      expect(ANYCUBIC_QUALIFIED_WRITES).toEqual([])
      const journey = await startJourneyHarness({
        browser,
        simulator: 'anycubic',
        printerModel: modelId,
        // Opted in to control with the shipped, empty list: still read-only.
        signedControl: true,
        history: true,
      })
      try {
        journey.ownerPage.setDefaultTimeout(15_000)
        const sim = simulator(journey)
        const page: Page = journey.ownerPage
        const noControls = () =>
          expect(page.getByRole('button', { name: CONTROLS })).toHaveCount(0)
        await openCard(journey)
        await expectState(journey, 'Imprimindo')
        await expectCard(journey, () =>
          expect(reportedProgress(card(journey))).toHaveAttribute(
            'aria-valuenow',
            reportedProgressValue(0.25),
            { timeout: 15_000 },
          ),
        )
        await expect(card(journey)).toContainText('215 °C')
        // Only the enclosed model has a chamber light and a chamber fan.
        for (const label of ['Luz da câmara', 'Ventilador da câmara'])
          await expectCard(journey, () =>
            expect(card(journey).getByText(label)).toHaveCount(
              chamberLight ? 1 : 0,
              { timeout: 15_000 },
            ),
          )
        await noControls()

        await sim.setOnline(false)
        await expect(
          card(journey)
            .getByText(/Dados desatualizados/)
            .first(),
        ).toBeVisible({ timeout: 90_000 })
        await noControls()

        // The job ends while the printer is unreachable.
        sim.finishPrint()
        await sim.setOnline(true)
        await openCard(journey)
        await expectState(journey, 'Ociosa')
        await noControls()

        await page.goto(
          `${journey.origin}/impressoras/${encodeURIComponent(journey.printerKey)}`,
        )
        const main = page.getByRole('main')
        await expect(
          main.getByText('Connector: conexão direta ativa', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect(main).toContainText('Ociosa', { timeout: 30_000 })
        // The heater form is always on this page; here it can send nothing.
        const heaterButtons = main.getByRole('button', { name: /^Definir / })
        await expect(heaterButtons.first()).toBeVisible({ timeout: 30_000 })
        for (const button of await heaterButtons.all())
          await expect(button).toBeDisabled()
        await expect(
          main.getByRole('button', {
            name: /^(Pausar|Retomar|Cancelar|Iniciar impressão)/,
          }),
        ).toHaveCount(0)

        // Nothing at all was published to the printer.
        expect(sim.writes).toEqual([])
        expect(sim.queries).toEqual([])
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      } finally {
        await journey.close()
      }
    })

    test(`${name}: a test-only qualified pair pauses, resumes and cancels`, async ({
      browser,
    }) => {
      test.setTimeout(15 * 60_000)
      const journey = await startJourneyHarness({
        browser,
        simulator: 'anycubic',
        printerModel: modelId,
        signedControl: true,
        history: true,
        connectorEntry: fileURLToPath(
          new URL(
            '../helpers/anycubic-qualified-connector.ts',
            import.meta.url,
          ),
        ),
      })
      try {
        const page = journey.ownerPage
        page.setDefaultTimeout(15_000)
        const sim = simulator(journey)
        const dialog = page.locator(
          'dialog[aria-labelledby="pause-dialog-title"]',
        )
        const actions = () =>
          sim.writes.map(({ type, action }) => `${type}/${action}`)

        /**
         * Opens a command dialog, confirms it and returns its settled text.
         * An authorization that never reached the printer is asked again, as
         * a person would; a sent command is never repeated.
         */
        let inboxesUsed = 0
        async function command(open: () => Promise<void>, confirm: string) {
          const status = dialog.getByRole('status')
          let last = ''
          for (let attempt = 0; attempt < 10; attempt++) {
            await expect
              .poll(
                () => {
                  const seen = journey.simulatorObservation()
                  return seen.pauseInboxReady && seen.pauseInboxes > inboxesUsed
                },
                { timeout: 45_000 },
              )
              .toBe(true)
              .catch(() => {})
            try {
              await expectCard(journey, open)
              await expect(dialog).toBeVisible({ timeout: 5000 })
            } catch {
              await openCard(journey)
              continue
            }
            const button = dialog.getByRole('button', {
              name: confirm,
              exact: true,
            })
            const ready = await expect(button)
              .toBeEnabled({ timeout: 45_000 })
              .then(
                () => true,
                () => false,
              )
            if (ready) {
              await button.click()
              await expect(
                dialog.getByRole('button', { name: 'Fechar', exact: true }),
              ).toBeVisible({ timeout: 60_000 })
            }
            last = (await status.innerText()).trim()
            await dialog
              .getByRole('button', { name: /^(Fechar|Cancelar)$/ })
              .click()
            await expect(dialog).toBeHidden()
            inboxesUsed = journey.simulatorObservation().pauseInboxes
            if (ready && !/recusado|não enviado|não foi enviado/i.test(last))
              return last
          }
          throw new Error('Command was never sent: ' + last)
        }
        const lifecycle = (label: string, confirm: string) =>
          command(async () => {
            const button = card(journey)
              .getByRole('group', {
                name: 'Controles da impressora ' + journey.printerKey,
              })
              .getByRole('button', { name: label, exact: true })
            await expect(button).toHaveAttribute('aria-disabled', 'false', {
              timeout: 10_000,
            })
            await button.click()
          }, confirm)
        const extended = () =>
          card(journey).getByRole('region', {
            name: 'Controles adicionais de ' + journey.printerKey,
          })

        await openCard(journey)
        await expectState(journey, 'Imprimindo')
        await expectCard(journey, async () => {
          await expect(extended().getByRole('button')).toHaveText(
            [
              'Definir temperatura',
              'Definir ventilador',
              ...(chamberLight ? ['Definir luz'] : []),
            ],
            { timeout: 15_000 },
          )
        })
        await expect(
          page.getByRole('button', { name: 'Iniciar impressão' }),
        ).toHaveCount(0)

        await command(async () => {
          await extended().getByLabel('Aquecedor').selectOption('extruder')
          await extended().getByLabel('Temperatura em °C').fill('205')
          await extended()
            .getByRole('button', { name: 'Definir temperatura', exact: true })
            .click()
        }, 'Confirmar comando')
        expect(sim.settings).toMatchObject({ target_nozzle_temp: 205 })
        if (chamberLight)
          await command(async () => {
            await extended().getByLabel('Luz').selectOption('on')
            await extended()
              .getByRole('button', { name: 'Definir luz', exact: true })
              .click()
          }, 'Confirmar comando')

        expect(await lifecycle('Pausar', 'Confirmar pausa')).toBe(
          'Impressão pausada. O Connector confirmou a pausa.',
        )
        expect(sim.lifecycle.state).toBe('paused')
        await expectState(journey, 'Pausada')

        expect(await lifecycle('Retomar', 'Confirmar retomada')).toBe(
          'Impressão retomada. O Connector confirmou a retomada.',
        )
        expect(sim.lifecycle.state).toBe('printing')
        await expectState(journey, 'Imprimindo')

        expect(await lifecycle('Cancelar', 'Confirmar cancelamento')).toMatch(
          /O Connector confirmou/,
        )
        expect(sim.lifecycle.state).toBe('idle')
        await expectState(journey, 'Ociosa')

        // Each command reached the printer exactly once.
        expect(actions()).toEqual([
          'print/update',
          ...(chamberLight ? ['light/control'] : []),
          'print/pause',
          'print/resume',
          'print/stop',
        ])
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      } finally {
        await journey.close()
      }
    })
  }
