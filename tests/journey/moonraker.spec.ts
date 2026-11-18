import { expect, test } from '@playwright/test'
import {
  journeyEnabled,
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
        const row = await journey.openFarm()
        await expect(row).toContainText('Conexão direta autenticada')
        await expect(row.getByRole('progressbar')).toHaveAttribute(
          'value',
          '0.25',
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
