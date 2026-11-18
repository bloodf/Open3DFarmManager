import { expect, test, type Locator, type Page } from '@playwright/test'
import type { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { discoverOnPage, expectCameraFrames } from './discovery-page.ts'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. One Creality (stock firmware) printer walks the
// whole journey against its loopback simulator: found by the Connector probe,
// set up, live telemetry, every advertised command, upload and start of a
// file, the job end card and the history entry. Capabilities with no
// documented stock protocol are asserted as "não suportado" in the page.
// Without the opt-in no test is registered, so nothing starts by accident.

type CrealitySim = Awaited<ReturnType<typeof createCrealitySimulator>>

const UPLOAD = 'peca-jornada.gcode'
const GCODE = Buffer.from('; journey\nG28\nG1 X10 Y10 F3000\nM84\n')
// These drivers do not supply action-specific confirmation evidence.
const UNCONFIRMED =
  'Resultado desconhecido. Verifique a impressora antes de tentar novamente.'
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NOT_SENT = /Nenhum comando foi enviado\./

if (journeyEnabled())
  test.describe('journey: Creality', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    const simulator = () => started().vendor?.raw as CrealitySim
    /** Parameters of every `set` request the simulator received. */
    const sets = () =>
      simulator()
        .requests.filter((request) => request.method === 'set')
        .map((request) => request.params)

    /** The printer's article on the farm page (no navigation). */
    const printerRow = (page: Page) =>
      page.getByRole('article').filter({
        has: page.getByRole('heading', {
          name: started().printerKey,
          exact: true,
        }),
      })
    const reportedState = (row: Locator, label: string) =>
      expect(
        row
          .locator('dt', { hasText: 'Último estado informado' })
          .locator('+ dd'),
      ).toHaveText(label, { timeout: 20_000 })

    /**
     * Each signed command or file operation consumes one control session of
     * the Connector, which then needs a moment to listen again. The page does
     * not wait for it (an early attempt fails closed, nothing sent), so the
     * journey waits for a fresh control inbox before every operation.
     */
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

    /**
     * Opens a command dialog, confirms it and waits for the Connector's
     * answer. Every command is signed in the browser and travels over its own
     * direct connection; nothing here calls the simulator. When the page
     * reports that the secure session ended before anything was sent, the
     * operator's only move is to open the command again: so does the journey.
     */
    async function command(
      page: Page,
      open: () => Promise<void>,
      button: string,
      outcome: string,
    ) {
      const dialog = page.getByRole('dialog')
      const status = dialog.getByRole('status')
      const confirmation = dialog.getByRole('button', {
        name: button,
        exact: true,
      })
      const close = async () => {
        await dialog
          .getByRole('button', { name: 'Fechar', exact: true })
          .click()
        await expect(dialog).toBeHidden()
      }
      for (let attempt = 1; ; attempt++) {
        await controlInbox()
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
        await close()
      }
      await confirmation.click()
      await expect(status).toHaveText(outcome, { timeout: 45_000 })
      await close()
    }

    /** One lifecycle command (Pausar, Retomar, Cancelar) from the row. */
    async function lifecycle(
      page: Page,
      label: string,
      button: string,
      outcome: string,
    ) {
      const control = printerRow(page)
        .getByRole('group', {
          name: 'Controles da impressora ' + started().printerKey,
        })
        .getByRole('button', { name: label, exact: true })
      await command(
        page,
        async () => {
          await expect(control).toHaveAttribute('aria-disabled', 'false', {
            timeout: 20_000,
          })
          await control.click()
        },
        button,
        outcome,
      )
    }

    const extendedControls = (page: Page) =>
      printerRow(page).getByRole('region', {
        name: 'Controles adicionais de ' + started().printerKey,
      })
    /** The form block of one extended command, found by its button. */
    const extendedBlock = (page: Page, label: string) =>
      extendedControls(page)
        .locator('div.control')
        .filter({
          has: page.getByRole('button', { name: label, exact: true }),
        })
    async function extended(
      page: Page,
      label: string,
      fill: (block: Locator) => Promise<void> = async () => {},
    ) {
      const block = extendedBlock(page, label)
      const control = block.getByRole('button', { name: label, exact: true })
      await command(
        page,
        async () => {
          await fill(block)
          await expect(control).toBeEnabled({ timeout: 20_000 })
          await control.click()
        },
        'Confirmar comando',
        UNCONFIRMED,
      )
    }

    /** Reloads the history until the finished job is listed. */
    async function expectHistory(page: Page, outcome: string, file: string) {
      const journey = started()
      // The Connector kept the finished job in its durable telemetry queue;
      // the history is written when that telemetry is delivered. Delivery
      // and live control displace each other on the server (one proof slot
      // per Connector credential), so the upload path opens only here.
      journey.setTelemetryUpload(true)
      try {
        await historyEntry(page, outcome, file)
      } finally {
        journey.setTelemetryUpload(false)
      }
    }
    async function historyEntry(page: Page, outcome: string, file: string) {
      const journey = started()
      await page.goto(journey.origin + '/historico', {
        waitUntil: 'domcontentloaded',
      })
      await expect(
        page.getByRole('heading', { name: 'Histórico de trabalhos' }),
      ).toBeVisible()
      const entry = page
        .getByRole('table', { name: 'Trabalhos finalizados' })
        .getByRole('row')
        .filter({ hasText: file })
        .filter({ hasText: outcome })
      await expect(async () => {
        const refresh = page.getByRole('button', {
          name: 'Atualizar histórico',
          exact: true,
        })
        await expect(refresh).toBeEnabled({ timeout: 5000 })
        await refresh.click()
        await expect(entry).toHaveCount(1, { timeout: 3000 })
      }).toPass({ timeout: 120_000 })
      await expect(
        entry.getByRole('cell', { name: journey.printerKey, exact: true }),
      ).toBeVisible()
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(20 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'creality',
        signedControl: true,
        discovery: true,
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test.afterEach(async ({}, testInfo) => {
      if (testInfo.status !== testInfo.expectedStatus && harness)
        console.error(
          JSON.stringify(harness.simulatorObservation()),
          JSON.stringify(simulator().requests),
          harness.appLog(),
          // What the operator saw on the page when it failed.
          await harness.ownerPage
            .locator('main')
            .innerText()
            .then((text) => text.slice(-4000))
            .catch(() => ''),
        )
    })

    test('the page finds the printer through discovery and the farm lists it', async () => {
      test.setTimeout(8 * 60_000)
      const journey = started()
      // Find: "Procurar impressoras" on Impressoras, answered by the
      // Connector's own Creality probe against the loopback responder; the
      // selected result prefills the set-up form.
      await discoverOnPage(journey, {
        family: 'creality-native',
        label: 'Creality K1',
        hostField: 'creality-host',
      })
      // Set up: the assignment is active on an approved Connector.
      const row = await journey.openFarm()
      await expect(row).toContainText('Atribuição ativa. Connector aprovado.')
    })

    test('live telemetry reaches the farm page', async () => {
      test.setTimeout(2 * 60_000)
      const journey = started()
      await journey.expectLiveTelemetry()
      const row = printerRow(journey.ownerPage)
      await reportedState(row, 'Imprimindo')
      const temperatures = row.getByLabel('Temperaturas observadas')
      await expect(temperatures).toContainText('210 °C')
      await expect(temperatures).toContainText('60 °C')
      const job = row.getByLabel('Trabalho atual')
      await expect(job).toContainText('journey.gcode')
      await expect(job).toContainText('25/100')
      // A scripted progress step from the simulator reaches the page.
      journey.controls.setProgress(40)
      await journey.expectProgress(0.4)
    })

    test('the farm page shows decoded camera frames from the printer', async () => {
      test.setTimeout(2 * 60_000)
      const journey = started()
      await expectCameraFrames(journey)
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })
    })

    test('pause and resume are confirmed by the printer state', async () => {
      test.setTimeout(3 * 60_000)
      const page = started().ownerPage
      const row = printerRow(page)
      await lifecycle(
        page,
        'Pausar',
        'Confirmar pausa',
        'Impressão pausada. O Connector confirmou a pausa.',
      )
      expect(simulator().state.state).toBe(2)
      await reportedState(row, 'Pausada')
      await lifecycle(
        page,
        'Retomar',
        'Confirmar retomada',
        'Impressão retomada. O Connector confirmou a retomada.',
      )
      expect(simulator().state.state).toBe(1)
      await reportedState(row, 'Imprimindo')
    })

    test('temperature, fan, light and homing commands reach the printer', async () => {
      test.setTimeout(8 * 60_000)
      const page = started().ownerPage
      const row = printerRow(page)

      await extended(page, 'Definir temperatura', async (block) => {
        await block.locator('select').selectOption('extruder')
        await block.locator('input').fill('215')
      })
      expect(sets()).toContainEqual({ nozzleTempControl: 215 })
      await extended(page, 'Definir temperatura', async (block) => {
        await block.locator('select').selectOption('bed')
        await block.locator('input').fill('65')
      })
      expect(sets()).toContainEqual({ bedTempControl: { num: 0, val: 65 } })

      await extended(page, 'Definir ventilador', async (block) => {
        await block.locator('select').selectOption('part')
        await block.locator('input').fill('100')
      })
      expect(sets()).toContainEqual({ fan: 1 })
      const environment = row.getByLabel('Ventilação e iluminação')
      await expect(environment).toContainText('Ventilador da peça')
      await expect(environment).toContainText('100%')

      await extended(page, 'Definir luz', async (block) => {
        await block.locator('select').selectOption('on')
      })
      expect(sets()).toContainEqual({ lightSw: 1 })
      await expect(environment).toContainText('Luz da câmara')
      await expect(environment).toContainText('Ligada')

      await extended(page, 'Referenciar eixos')
      expect(sets()).toContainEqual({ autohome: 'X Y Z' })
    })

    test('commands without a documented stock protocol are shown as não suportado', async () => {
      const page = started().ownerPage
      const controls = extendedControls(page)
      await expect(
        controls.getByRole('heading', {
          name: 'Comandos não suportados por esta impressora',
        }),
      ).toBeVisible()
      for (const label of [
        'Definir velocidade',
        'Reiniciar firmware',
        'Parada de emergência',
        'Carregar filamento',
        'Descarregar filamento',
      ]) {
        await expect(
          controls
            .locator('dt', { hasText: new RegExp(`^${escape(label)}$`) })
            .locator('+ dd'),
        ).toHaveText('Não suportado')
        await expect(
          controls.getByRole('button', { name: label, exact: true }),
        ).toHaveCount(0)
      }
    })

    test('cancel ends the job: end card and history entry', async () => {
      test.setTimeout(4 * 60_000)
      const page = started().ownerPage
      const row = printerRow(page)
      await lifecycle(
        page,
        'Cancelar',
        'Confirmar cancelamento',
        'Impressão cancelada. O Connector confirmou o cancelamento.',
      )
      expect(sets()).toContainEqual({ stop: 1 })
      await reportedState(row, 'Ociosa')
      await expect(row.getByText('Cancelado', { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(row.getByLabel('Último trabalho')).toContainText(
        'journey.gcode',
      )
      await expectHistory(page, 'Cancelado', 'journey.gcode')
    })

    test('a file is uploaded and started; the job ends with its card and history entry', async () => {
      test.setTimeout(6 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      await page.goto(journey.origin + '/arquivos', {
        waitUntil: 'domcontentloaded',
      })
      await expect(
        page.getByRole('heading', { name: 'Arquivos', exact: true }),
      ).toBeVisible()
      const printers = page.locator('#files-printer')
      await expect(
        printers.locator('option', { hasText: journey.printerKey }),
      ).toHaveCount(1, { timeout: 30_000 })
      await printers.selectOption({ label: journey.printerKey })
      const input = page.locator('#files-upload')
      await expect(input).toBeEnabled({ timeout: 45_000 })
      const status = page.getByRole('status').last()

      /**
       * One file operation over a fresh control session. The page reports a
       * session that failed, or that it cancelled because the live state
       * blinked, before the work was done; the operator repeats the
       * operation, and so does the journey.
       */
      async function fileOperation(label: string, result: string) {
        const undone = [
          'Não foi possível concluir pela conexão direta. Verifique a impressora antes de tentar novamente.',
          'Operação cancelada neste navegador. Confira o estado da impressora e seus arquivos antes de tentar novamente.',
        ]
        const settled = new RegExp(
          `^(${[result, ...undone].map(escape).join('|')})$`,
        )
        for (let attempt = 1; ; attempt++) {
          await controlInbox()
          await expect(input).toBeEnabled({ timeout: 45_000 })
          await page.getByRole('button', { name: label, exact: true }).click()
          await expect(status).toHaveText(settled, { timeout: 60_000 })
          const text = (await status.textContent()) ?? ''
          if (text === result) return
          expect(attempt, text).toBeLessThan(5)
        }
      }

      // The stock protocol documents no file listing.
      await fileOperation(
        'Consultar arquivos',
        'Listagem não suportada pela biblioteca desta impressora.',
      )

      await input.setInputFiles({
        name: UPLOAD,
        mimeType: 'text/plain',
        buffer: GCODE,
      })
      await fileOperation(
        'Enviar arquivo',
        'Arquivo enviado. Selecione-o e confirme para iniciar a impressão.',
      )
      // The printer's own HTTP upload endpoint stored it (multipart body).
      expect(simulator().uploads.get(UPLOAD)).toBeGreaterThan(GCODE.length)

      // Starting is never repeated: one attempt on a fresh control session.
      await controlInbox()
      await page.locator('#files-existing').selectOption(UPLOAD)
      await page.getByRole('checkbox').check()
      await page
        .getByRole('button', { name: 'Iniciar impressão', exact: true })
        .click()
      await expect(status).toHaveText(
        'Resultado desconhecido. Verifique a impressora antes de tentar novamente.',
        { timeout: 60_000 },
      )
      expect(sets()).toContainEqual({
        opGcodeFile: `printprt:/usr/data/printer_data/gcodes/${UPLOAD}`,
      })

      // The print runs to the end on its own; the card names the finished job.
      const row = await journey.openFarm()
      await expect(row.getByText('Concluído', { exact: true })).toBeVisible({
        timeout: 60_000,
      })
      await expect(row.getByLabel('Último trabalho')).toContainText(UPLOAD)
      await reportedState(row, 'Ociosa')
      expect(simulator().state).toMatchObject({ state: 0, printProgress: 100 })

      await expectHistory(page, 'Concluído', UPLOAD)
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })
    })
  })
