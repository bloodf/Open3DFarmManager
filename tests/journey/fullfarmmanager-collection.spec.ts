import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'

import { floorTile, openLiveInspector } from './fullfarmmanager-fixture.ts'

const FILE = 'collection.gcode'

test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 })

if (journeyEnabled())
  test('jornada FullFarmManager: retém a próxima impressão até a retirada', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const journey = await startJourneyHarness({
      browser,
      signedControl: true,
      history: true,
      moonraker: { mock: { files: [{ path: FILE, content: 'G28\n' }] } },
    })
    try {
      // The issuer grants only persisted advertised controls. Wait for the
      // synthetic Connector's telemetry before opening a single-use peer.
      await expect
        .poll(() => journey.advertisedControls(), { timeout: 90_000 })
        .toEqual(expect.arrayContaining(['file_op', 'start_print']))
      journey.setTelemetryUpload(false)
      const page = journey.ownerPage
      const row = await openLiveInspector(journey)
      const tile = floorTile(journey)
      const detailLink = row.getByRole('link', {
        name: /^Abrir detalhes da impressora/,
      })
      await detailLink.click()
      await expect(
        page.getByRole('heading', { name: journey.printerKey, exact: true }),
      ).toBeVisible()
      const detailUrl = page.url()
      const files = page.getByRole('region', { name: 'Arquivos da impressora' })
      const start = files.getByRole('button', {
        name: 'Iniciar impressão',
        exact: true,
      })
      const inboxReady = async (after = 0) => {
        await expect
          .poll(
            () => {
              const observation = journey.simulatorObservation()
              return (
                observation.pauseInboxReady && observation.pauseInboxes > after
              )
            },
            { timeout: 90_000 },
          )
          .toBe(true)
      }
      const selectFile = async () => {
        await page.getByRole('tab', { name: 'Arquivos', exact: true }).click()
        await inboxReady()
        const listens = journey.simulatorObservation().pauseInboxes
        await files.getByRole('button', { name: 'Atualizar arquivos' }).click()
        await expect(files.getByRole('status')).toHaveText(
          'Arquivos atualizados.',
          { timeout: 60_000 },
        )
        await files.getByRole('radio', { name: /collection\.gcode/ }).check()
        await inboxReady(listens)
      }
      const confirmStart = async (held = false) => {
        const listens = journey.simulatorObservation().pauseInboxes
        await start.click()
        const dialog = page.getByRole('dialog', {
          name: `start_print — ${journey.printerKey}`,
        })
        await dialog.getByRole('button', { name: 'Confirmar comando' }).click()
        await expect(dialog.getByRole('status')).toHaveText(
          held ? 'Comando não enviado.' : 'Comando confirmado pelo Connector.',
          { timeout: 60_000 },
        )
        await dialog.getByRole('button', { name: 'Fechar' }).click()
        await inboxReady(listens)
      }
      // Establish an OpenFarm-owned attempt through the browser before finishing it.
      journey.printer.update({ state: 'standby', progress: 0 })
      await selectFile()
      await confirmStart()
      await expect
        .poll(() => journey.printer.calls()['printer.print.start'])
        .toBe(1)
      await expect
        .poll(() => journey.printer.model())
        .toMatchObject({
          state: 'printing',
          filename: FILE,
        })
      await journey.openFarm()
      await expect(
        tile.getByRole('button', {
          name: `Inspecionar ${journey.printerKey} Imprimindo`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 60_000 })
      journey.controls.finishPrint()
      const hold = tile
        .getByRole('status')
        .filter({ hasText: 'Aguardando retirada.' })
      await expect(hold).toBeVisible({ timeout: 60_000 })
      // The hold adds the release action to the Connector's advertisement.
      journey.setTelemetryUpload(true)
      await expect
        .poll(() => journey.advertisedControls(), { timeout: 90_000 })
        .toContain('confirm_collection')
      journey.setTelemetryUpload(false)

      await page.goto(detailUrl)
      await selectFile()
      await confirmStart(true)
      expect(journey.printer.calls()['printer.print.start']).toBe(1)

      await journey.openFarm()
      await expect(hold).toBeVisible({ timeout: 60_000 })
      await inboxReady()
      const collectionListen = journey.simulatorObservation().pauseInboxes
      await tile
        .getByRole('button', { name: 'Confirmar placa livre', exact: true })
        .click()
      const collection = page.getByRole('dialog', {
        name: /Confirmar placa livre/,
      })
      await collection
        .getByRole('button', { name: 'Confirmar placa livre', exact: true })
        .click()
      await expect(collection.getByRole('status')).toHaveText(
        'Comando confirmado pelo Connector.',
      )
      await collection.getByRole('button', { name: 'Fechar' }).click()
      await inboxReady(collectionListen)
      await expect(hold).toBeHidden()
      expect(journey.printer.calls()['printer.print.start']).toBe(1)

      await page.goto(detailUrl)
      await selectFile()
      await expect(start).toBeEnabled()
      await confirmStart()
      await expect
        .poll(() => journey.printer.calls()['printer.print.start'])
        .toBe(2)
    } finally {
      await journey.close()
    }
  })
