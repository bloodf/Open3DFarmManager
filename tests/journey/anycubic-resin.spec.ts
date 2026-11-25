// Photon P1 Max against the loopback resin simulator only.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import {
  assertCameraPlaying,
  helperProcesses,
} from '../helpers/signalling-farm-camera.ts'
import {
  commandDialog,
  expectInspectedTelemetry,
  inspectPrinter,
} from './creality-inspector.ts'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'
import type { startAnycubicResinFixture } from './anycubic-resin-fixture.ts'

const TEST_ONLY_QUALIFIED_CONNECTOR = fileURLToPath(
  new URL('./anycubic-resin-connector.ts', import.meta.url),
)

const NOT_SENT = /Nenhum comando foi enviado\./

type Fixture = Awaited<ReturnType<typeof startAnycubicResinFixture>>

/** Every MQTT request that changes the printer, as the simulator received it. */
function writes(fixture: Fixture) {
  return fixture.simulator
    .received()
    .filter((operation) => /^(print\/(?!query)|video\/)/.test(operation))
}

async function connectorLog(journey: JourneyHarness) {
  return readFile(
    join(journey.simulatorObservation().directory, 'data', 'runtime.jsonl'),
    'utf8',
  )
}

async function start(
  browser: Parameters<typeof startJourneyHarness>[0]['browser'],
  qualified: boolean,
) {
  const journey = await startJourneyHarness({
    browser,
    simulator: 'anycubic-resin',
    // The issuer grants only controls a recent telemetry upload advertised.
    history: true,
    signedControl: true,
    ...(qualified ? { connectorEntry: TEST_ONLY_QUALIFIED_CONNECTOR } : {}),
  })
  const fixture = journey.vendor?.raw as Fixture
  return { journey, fixture }
}

function surfaces(journey: JourneyHarness, page: Page) {
  const row = journey.farmRow(page)
  const controls = row.getByRole('group', {
    name: `Controles da impressora ${journey.printerKey}`,
  })
  return {
    row,
    button: (name: string) =>
      controls.getByRole('button', { name, exact: true }),
    camera: page.getByRole('region', {
      name: `Câmera da impressora ${journey.printerKey}`,
      exact: true,
    }),
  }
}

async function controlInbox(journey: JourneyHarness) {
  await expect
    .poll(() => journey.simulatorObservation().pauseInboxReady, {
      timeout: 90_000,
    })
    .toBe(true)
}

if (journeyEnabled()) {
  test('Photon P1 Max: status is live and every write stays refused until qualified', async ({
    browser,
  }) => {
    test.setTimeout(8 * 60_000)
    const { journey, fixture } = await start(browser, false)
    try {
      const page = journey.ownerPage
      await expectInspectedTelemetry(journey)
      const { row, button, camera } = surfaces(journey, page)
      await expect(row).toContainText('Imprimindo — dados de simulador')
      await journey.expectProgress(0.25)
      await controlInbox(journey)

      // The Connector advertises no control, so none is offered to sign.
      for (const name of ['Pausar', 'Retomar', 'Cancelar'])
        await expect(button(name)).toHaveCount(0)
      expect(await journey.advertisedControls()).toEqual([])

      // The camera start is a printer write: refused with a logged reason.
      await expect
        .poll(() => connectorLog(journey).catch(() => ''), { timeout: 60_000 })
        .toContain(
          'Photon LAN camera is not qualified for this model and firmware',
        )
      await expect(camera.getByText('Câmera ao vivo.')).toHaveCount(0)

      expect(writes(fixture)).toEqual([])
      expect(journey.appLog()).not.toContain(fixture.password)
      expect(await connectorLog(journey)).not.toContain(fixture.password)
    } finally {
      await journey.close()
    }
  })

  test('Photon P1 Max with the test-only qualification: camera, recovery and signed cancel', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const { journey, fixture } = await start(browser, true)
    try {
      const page = journey.ownerPage
      const helperPath = fixture.encoder.path
      const note = async (value: string) => {
        await test
          .info()
          .attach(value, { body: value, contentType: 'text/plain' })
      }
      await expectInspectedTelemetry(journey)
      const { row, button } = surfaces(journey, page)
      await expect(row).toContainText('Imprimindo — dados de simulador')

      // Camera: started by MQTT, delivered over WebRTC, stopped with the view.
      await assertCameraPlaying({
        page,
        printerKey: journey.printerKey,
        helperPath,
        note,
      })
      expect(fixture.simulator.received()).toContain('video/startCapture')
      // Leaving the view ends the peer: the helper exits, the printer stops.
      await page.goto(journey.origin + '/historico', {
        waitUntil: 'domcontentloaded',
      })
      await expect
        .poll(() => helperProcesses(helperPath), { timeout: 45_000 })
        .toBe(0)
      await expect
        .poll(() => fixture.simulator.printer().cameraStreaming, {
          timeout: 45_000,
        })
        .toBe(false)
      expect(fixture.simulator.received()).toContain('video/stopCapture')

      // A lost broker link is shown as stale, then the session is reopened.
      await inspectPrinter(journey)
      await expect(row).toContainText('Imprimindo', { timeout: 60_000 })
      const exchanges = fixture.simulator.exchanges()
      fixture.simulator.disconnect()
      await expect(
        row.getByText(
          'Conexão direta indisponível. Exibindo a última observação.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 90_000 })
      // The page may re-admit its link before the Connector reopens the
      // printer session, so wait for the one new `/info` exchange first.
      await expect
        .poll(() => fixture.simulator.exchanges(), { timeout: 90_000 })
        .toBe(exchanges + 1)
      await inspectPrinter(journey)
      await expect(
        row.getByText('Conexão direta autenticada', { exact: true }),
      ).toBeVisible({ timeout: 120_000 })
      await expect(row).toContainText('Imprimindo — dados de simulador')
      expect(fixture.simulator.exchanges()).toBe(exchanges + 1)

      // Signed cancel: one stop, confirmed by the printer's own report.
      expect(writes(fixture).filter((op) => op.startsWith('print/'))).toEqual(
        [],
      )
      const dialog = commandDialog(journey, page)
      const status = dialog.getByRole('status')
      const confirm = dialog.getByRole('button', {
        name: 'Confirmar cancelamento',
        exact: true,
      })
      // As in the other signed journeys: a control session that ends before
      // anything was sent leaves the operator to open the command again, on a
      // fresh control inbox. The view is reopened too, because the page's own
      // direct link does not always return by itself after such an end.
      let inboxesUsed = 0
      for (let attempt = 1; ; attempt++) {
        await inspectPrinter(journey)
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect
          .poll(
            () => {
              const { pauseInboxReady, pauseInboxes } =
                journey.simulatorObservation()
              return pauseInboxReady && pauseInboxes > inboxesUsed
            },
            { timeout: 90_000 },
          )
          .toBe(true)
        inboxesUsed = journey.simulatorObservation().pauseInboxes
        await expect(button('Cancelar')).toHaveAttribute(
          'aria-disabled',
          'false',
          { timeout: 60_000 },
        )
        for (const name of ['Pausar', 'Retomar'])
          await expect(button(name)).toHaveCount(0)
        await button('Cancelar').click()
        await expect(async () => {
          expect(
            (await confirm.isEnabled()) ||
              NOT_SENT.test((await status.textContent()) ?? ''),
          ).toBe(true)
        }).toPass({ timeout: 45_000 })
        if (await confirm.isEnabled()) break
        expect(attempt, (await status.textContent()) ?? '').toBeLessThan(4)
      }
      await confirm.click()
      await expect(status).toHaveText(
        'Impressão cancelada. O Connector confirmou o cancelamento.',
        { timeout: 45_000 },
      )
      expect(fixture.simulator.printer().job).toBeNull()
      expect(writes(fixture).filter((op) => op.startsWith('print/'))).toEqual([
        'print/stop',
      ])
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
      await expect(row).toContainText('Ociosa', { timeout: 60_000 })
      expect(journey.appLog()).not.toContain(fixture.password)
    } finally {
      await journey.close()
    }
  })
}
