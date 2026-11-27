import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { HALOT_QUALIFIED_WRITES } from '../../packages/connector/src/halot/qualification.ts'
import { openFarmInspector } from '../helpers/farm-inspector.ts'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import { statusJourney } from './status-journey.ts'
import type { startStatusFixture } from './status-fixtures.ts'

// Simulator only: synthetic state, never a physical printer. The shipped write
// qualification list is empty; the qualification exists only in the helper
// Connector of the second journey.

// Shipped list: status only, with no control offered anywhere.
statusJourney('halot')

if (journeyEnabled()) {
  test('halot: the shipped qualification list is empty', () => {
    expect(HALOT_QUALIFIED_WRITES).toEqual([])
  })

  test('halot: a test-only qualification accepts signed pause, resume and cancel', async ({
    browser,
  }) => {
    test.setTimeout(15 * 60_000)
    const journey = await startJourneyHarness({
      browser,
      simulator: 'halot',
      signedControl: true,
      // The server issues authority from the controls telemetry advertises.
      history: true,
      connectorEntry: fileURLToPath(
        new URL('../helpers/halot-qualified-connector.ts', import.meta.url),
      ),
    })
    try {
      const { halot } = journey.vendor?.raw as Extract<
        Awaited<ReturnType<typeof startStatusFixture>>,
        { halot: unknown }
      >
      halot.beginPrint('part.cxdlpv4')

      const page = journey.ownerPage
      const dialog = page.locator(
        'dialog[aria-labelledby="pause-dialog-title"]',
      )
      const card = () =>
        page
          .getByRole('dialog', { name: 'Inspeção da impressora', exact: true })
          .getByRole('article')
          .filter({
            has: page.getByRole('heading', { name: journey.printerKey }),
          })
      const openCard = async () => {
        await journey.openFarm(page)
        await openFarmInspector(page, journey.printerKey)
      }
      await openCard()

      /**
       * Opens a command dialog, confirms it and returns its settled text. An
       * authorization that never reached the printer is asked again, as a
       * person would; a sent command is never repeated.
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
            await open()
            await expect(dialog).toBeVisible({ timeout: 5000 })
          } catch {
            await openCard()
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
            inboxesUsed = journey.simulatorObservation().pauseInboxes
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
          // Only an outcome that says nothing was sent is asked again.
          if (ready && !/Nenhum comando foi enviado/.test(last)) return last
        }
        throw new Error('Command was never settled: ' + last)
      }
      const lifecycle = (label: string, confirm: string) => {
        const button = () =>
          card()
            .getByRole('group', {
              name: 'Controles da impressora ' + journey.printerKey,
            })
            .getByRole('button', { name: label, exact: true })
        return command(async () => {
          await expect(button()).toHaveAttribute('aria-disabled', 'false', {
            timeout: 60_000,
          })
          await button().click({ timeout: 5000 })
        }, confirm)
      }

      expect(await lifecycle('Pausar', 'Confirmar pausa')).toContain(
        'confirmou',
      )
      expect(halot.machine.printStatus).toBe('PRINT_PAUSE')
      expect(halot.writes()).toEqual(['PRINT_PAUSE'])

      expect(await lifecycle('Retomar', 'Confirmar retomada')).toContain(
        'confirmou',
      )
      expect(halot.machine.printStatus).toBe('PRINT_PROCESSING')
      expect(halot.writes()).toEqual(['PRINT_PAUSE', 'PRINT_PAUSE'])

      expect(await lifecycle('Cancelar', 'Confirmar cancelamento')).toContain(
        'confirmou',
      )
      expect(halot.machine.printStatus).toBe('TEST_CANCELLED')
      expect(halot.writes()).toEqual([
        'PRINT_PAUSE',
        'PRINT_PAUSE',
        'PRINT_STOP',
      ])
      expect(halot.binaryFrames()).toBe(0)

      // The page offers no start: upload and start are not implemented.
      await expect(card()).toBeVisible()
      await expect(
        card().getByRole('button', { name: /iniciar impressão/i }),
      ).toHaveCount(0)
    } finally {
      await journey.close()
    }
  })
}
