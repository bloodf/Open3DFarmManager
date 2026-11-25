import { expect, test, type Locator, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { commandDialog, inspectPrinter } from './creality-inspector.ts'
import { expectCameraFrames } from './discovery-page.ts'
import {
  journeyEnabled,
  reportedProgress,
  reportedProgressValue,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'
import type { startSdcpControlFixture } from './sdcp-control-fixture.ts'

// Opt-in: OPENFARM_JOURNEY=1. Simulator only (spec-derived SDCP resin board,
// tests/journey/sdcp-control-fixture.ts). Needs Go for the camera helper.

type Sim = Awaited<ReturnType<typeof startSdcpControlFixture>>
const NOT_SENT = /Nenhum comando foi enviado\./
const simulator = (journey: JourneyHarness) => journey.vendor?.raw as Sim

function start(browser: Parameters<typeof startJourneyHarness>[0]['browser']) {
  return startJourneyHarness({
    browser,
    simulator: 'sdcp',
    control: true,
    signedControl: true,
    // The issuer grants only controls advertised in the last two minutes.
    history: true,
  })
}

/**
 * One signed command from the current page: opened, confirmed, its outcome
 * read. Each consumes one control session of the Connector.
 */
function commander(journey: JourneyHarness) {
  let used = 0
  const page = journey.ownerPage
  return async (control: Locator, confirm: string, outcome: string) => {
    const dialog = commandDialog(journey, page)
    const status = dialog.getByRole('status')
    const button = dialog.getByRole('button', { name: confirm, exact: true })
    for (let attempt = 1; ; attempt++) {
      await expect
        .poll(
          () => {
            const seen = journey.simulatorObservation()
            return seen.pauseInboxReady && seen.pauseInboxes > used
          },
          { timeout: 90_000 },
        )
        .toBe(true)
      used = journey.simulatorObservation().pauseInboxes
      await expect(control).toBeEnabled({ timeout: 60_000 })
      await expect(control).not.toHaveAttribute('aria-disabled', 'true', {
        timeout: 60_000,
      })
      await control.click()
      await expect(dialog).toBeVisible()
      await expect(async () => {
        expect(
          (await button.isEnabled()) ||
            NOT_SENT.test((await status.textContent()) ?? ''),
        ).toBe(true)
      }).toPass({ timeout: 45_000 })
      if (await button.isEnabled()) break
      // Fail-closed before any send: the operator opens the command again.
      expect(attempt, (await status.textContent()) ?? '').toBeLessThan(4)
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
      await expect(dialog).toBeHidden()
    }
    await button.click()
    await expect(status).toHaveText(outcome, { timeout: 45_000 })
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
}

function lifecycle(journey: JourneyHarness, label: string) {
  return journey
    .farmRow()
    .getByRole('group', {
      name: 'Controles da impressora ' + journey.printerKey,
    })
    .getByRole('button', { name: label, exact: true })
}

async function liveRow(journey: JourneyHarness) {
  const row = await inspectPrinter(journey)
  await expect(
    row.getByText('Conexão direta autenticada', { exact: true }),
  ).toBeVisible({ timeout: 90_000 })
  await expect(row).toContainText('Imprimindo', { timeout: 30_000 })
  await expect(reportedProgress(row)).toHaveAttribute(
    'aria-valuenow',
    reportedProgressValue(0.25),
  )
  return row
}

async function openDetail(page: Page) {
  const link = page
    .getByRole('dialog', { name: 'Inspeção da impressora' })
    .getByRole('link', { name: 'Abrir detalhes da impressora' })
  await page.goto(new URL((await link.getAttribute('href'))!, page.url()).href)
  const main = page.getByRole('main')
  await expect(
    main.getByText('Connector: conexão direta ativa', { exact: true }),
  ).toBeVisible({ timeout: 90_000 })
  return main
}

if (journeyEnabled()) {
  test('SDCP: signed pause, resume and cancel, history; start and camera stay off', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const journey = await start(browser)
    try {
      const sim = simulator(journey)
      const row = await liveRow(journey)
      const state = (label: string) =>
        expect(
          row
            .locator('dt', { hasText: 'Último estado informado' })
            .locator('+ dd'),
        ).toHaveText(label, { timeout: 30_000 })

      // Start is gated: no pair is qualified, so it is not advertised.
      await expect
        .poll(async () => [...(await journey.advertisedControls())].sort(), {
          timeout: 60_000,
        })
        .toEqual(['cancel', 'pause', 'resume'])
      await expect(
        row
          .getByRole('group', {
            name: 'Controles da impressora ' + journey.printerKey,
          })
          .getByRole('button'),
      ).toHaveText(['Pausar', 'Retomar', 'Cancelar'])
      await expect(
        row.getByRole('button', { name: /iniciar impressão/i }),
      ).toHaveCount(0)
      // The camera is configured but not qualified: nothing is enabled.
      await expect(
        journey.ownerPage
          .getByRole('region', {
            name: `Câmera da impressora ${journey.printerKey}`,
            exact: true,
          })
          .getByText('Câmera indisponível.', { exact: true }),
      ).toBeVisible()

      const command = commander(journey)
      await command(
        lifecycle(journey, 'Pausar'),
        'Confirmar pausa',
        'Impressão pausada. O Connector confirmou a pausa.',
      )
      expect(sim.machine.phase).toBe('paused')
      await state('Pausada')
      await command(
        lifecycle(journey, 'Retomar'),
        'Confirmar retomada',
        'Impressão retomada. O Connector confirmou a retomada.',
      )
      expect(sim.machine.phase).toBe('printing')
      await state('Imprimindo')
      await command(
        lifecycle(journey, 'Cancelar'),
        'Confirmar cancelamento',
        'Impressão cancelada. O Connector confirmou o cancelamento.',
      )
      expect(sim.machine.phase).toBe('stopped')
      await state('Ociosa')
      // One frame per signed command, nothing retried, no start, no video.
      expect(sim.commands()).toEqual([
        { cmd: 129, data: {} },
        { cmd: 131, data: {} },
        { cmd: 130, data: {} },
      ])

      const main = await openDetail(journey.ownerPage)
      await main.getByRole('tab', { name: 'Histórico' }).click()
      const jobs = main.getByRole('table', {
        name: 'Trabalhos finalizados desta impressora',
      })
      const finished = (file: string) =>
        jobs.getByRole('row').filter({ hasText: file })
      await expect(finished('journey.goo')).toContainText('Cancelado', {
        timeout: 60_000,
      })
      await expect(finished('anterior.goo')).toContainText('Concluído')
      await expect(main.getByRole('heading', { name: 'Câmeras' })).toHaveCount(
        0,
      )
      await expect(
        main.getByRole('button', { name: 'Iniciar impressão' }),
      ).toHaveCount(0)
      expect(
        sim.commands().filter(({ cmd }) => cmd === 320).length,
      ).toBeGreaterThan(0)
      expect(
        sim.commands().filter(({ cmd }) => [128, 386].includes(cmd)),
      ).toEqual([])
      expect(sim.machine.videoStreams).toBe(0)
    } finally {
      await journey.close()
    }
  })

  test('SDCP camera: signed on and off only with a test-only video qualification', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    // The Connector from source with the simulator pair qualified.
    process.env.SIGNALLING_HTTPS_CONNECTOR_ENTRY = fileURLToPath(
      new URL('./sdcp-qualified-connector.ts', import.meta.url),
    )
    let journey: JourneyHarness | undefined
    try {
      journey = await start(browser)
      const sim = simulator(journey)
      const page = journey.ownerPage
      const video = () => sim.commands().filter(({ cmd }) => cmd === 386)
      await liveRow(journey)
      await expect
        .poll(async () => [...(await journey!.advertisedControls())].sort(), {
          timeout: 60_000,
        })
        .toEqual(['cancel', 'pause', 'power', 'resume'])
      // Opening the camera view writes nothing: the stream is off.
      await expect(
        page
          .getByRole('region', {
            name: `Câmera da impressora ${journey.printerKey}`,
            exact: true,
          })
          .getByText('Câmera indisponível.', { exact: true }),
      ).toBeVisible()
      expect(video()).toEqual([])

      const command = commander(journey)
      const unconfirmed =
        'Resultado desconhecido. Verifique a impressora antes de tentar novamente.'
      /** The signed switch on the detail page, then the reported device. */
      const power = async (label: string, now: string) => {
        const main = await openDetail(page)
        await main.getByRole('tab', { name: 'Sistema' }).click()
        await command(
          main.getByRole('button', { name: `${label} Câmera`, exact: true }),
          'Confirmar comando',
          unconfirmed,
        )
        await expect(main.getByText(`Câmera — ${now}`)).toBeVisible({
          timeout: 30_000,
        })
      }
      await power('Ligar', 'Ligado')
      expect(video()).toEqual([{ cmd: 386, data: { Enable: 1 } }])
      expect(sim.machine.videoStreams).toBe(1)

      await liveRow(journey)
      await expectCameraFrames(journey)
      // Viewing added no write.
      expect(video()).toHaveLength(1)

      await liveRow(journey)
      await power('Desligar', 'Desligado')
      expect(video()).toEqual([
        { cmd: 386, data: { Enable: 1 } },
        { cmd: 386, data: { Enable: 0 } },
      ])
      expect(sim.machine.videoStreams).toBe(0)
    } finally {
      delete process.env.SIGNALLING_HTTPS_CONNECTOR_ENTRY
      await journey?.close()
    }
  })
}
