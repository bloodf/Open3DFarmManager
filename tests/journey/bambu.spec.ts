import { expect, test, type Locator, type Page } from '@playwright/test'
import type { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import {
  BAMBU_LAN_ADDRESS,
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'
import { BAMBU_ACCESS_CODE } from './harness-vendors.ts'

type BambuSim = Awaited<ReturnType<typeof startBambuSimulator>>
const FILE = 'jornada-bambu.gcode'
const GCODE = Buffer.from('; jornada Bambu\nG28\nG1 X10 Y10 F3000\n')
const UNKNOWN =
  'Resultado desconhecido. Verifique a impressora antes de tentar novamente.'
const NOT_SENT = /Nenhum comando foi enviado\./

if (journeyEnabled())
  test.describe('journey: Bambu Lab', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined
    let inboxesUsed = 0

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    const simulator = () => started().vendor?.raw as BambuSim
    const row = (page: Page) =>
      page.getByRole('article').filter({
        has: page.getByRole('heading', {
          name: started().printerKey,
          exact: true,
        }),
      })

    async function controlInbox() {
      const observe = () => started().simulatorObservation()
      await expect
        .poll(
          () => {
            const { pauseInboxReady, pauseInboxes } = observe()
            return pauseInboxReady && pauseInboxes > inboxesUsed
          },
          { timeout: 60_000 },
        )
        .toBe(true)
      inboxesUsed = observe().pauseInboxes
    }

    async function command(
      page: Page,
      open: () => Promise<void>,
      confirmName: string,
      outcome: string,
    ) {
      const dialog = page.getByRole('dialog')
      const status = dialog.getByRole('status')
      const confirm = dialog.getByRole('button', {
        name: confirmName,
        exact: true,
      })
      for (let attempt = 1; attempt <= 3; attempt++) {
        await controlInbox()
        await open()
        await expect(dialog).toBeVisible()
        const ready = await expect
          .poll(
            async () =>
              (await confirm.isEnabled()) ||
              NOT_SENT.test((await status.textContent()) ?? ''),
            { timeout: 45_000 },
          )
          .toBe(true)
          .then(() => confirm.isEnabled())
        if (ready) {
          // Once confirmed, the action is issued once and never retried.
          await confirm.click()
          await expect(status).toHaveText(outcome, { timeout: 45_000 })
          await dialog.getByRole('button', { name: 'Fechar' }).click()
          await expect(dialog).toBeHidden()
          return
        }
        expect(attempt, (await status.textContent()) ?? '').toBeLessThan(3)
        await dialog.getByRole('button', { name: 'Fechar' }).click()
        await expect(dialog).toBeHidden()
      }
      throw new Error('Bambu command never opened an authorized session')
    }

    async function lifecycle(
      page: Page,
      label: string,
      confirm: string,
      result: string,
    ) {
      const control = row(page)
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
        confirm,
        result,
      )
    }

    const extended = (page: Page) =>
      row(page).getByRole('region', {
        name: 'Controles adicionais de ' + started().printerKey,
      })

    async function extendedCommand(
      page: Page,
      label: string,
      fill: (block: Locator) => Promise<void> = async () => {},
    ) {
      const block = extended(page)
        .locator('div.control')
        .filter({ has: page.getByRole('button', { name: label, exact: true }) })
      const control = block.getByRole('button', { name: label, exact: true })
      await command(
        page,
        async () => {
          await fill(block)
          // Same allowance as the lifecycle buttons after the last session.
          await expect(control).toBeEnabled({ timeout: 20_000 })
          await control.click()
        },
        'Confirmar comando',
        UNKNOWN,
      )
    }

    async function filamentCommand(
      page: Page,
      label: string,
      fill: (section: Locator) => Promise<void> = async () => {},
    ) {
      const section = row(page).getByRole('region', {
        name: 'Macros e filamento de ' + started().printerKey,
      })
      const button = section.getByRole('button', { name: label, exact: true })
      await command(
        page,
        async () => {
          await fill(section)
          await expect(button).toBeEnabled({ timeout: 20_000 })
          await button.click()
        },
        'Confirmar comando',
        UNKNOWN,
      )
    }

    async function historyEntry(page: Page, outcome: string) {
      const journey = started()
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
          .filter({ hasText: outcome })
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
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(5 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'bambu',
        control: true,
        signedControl: true,
        history: true,
        setup: async ({ page, origin, farmId, configurator }) => {
          if (!configurator)
            throw new Error('Bambu browser set-up needs its config Connector')
          await page.goto(origin + '/impressoras', {
            waitUntil: 'domcontentloaded',
          })
          await page.getByLabel('Farm', { exact: true }).selectOption(farmId)
          await page
            .locator('#kobra-connector')
            .selectOption(configurator.agentId)
          const ready = page.getByText(/Connector apto \(protocolo/)
          const verify = page.getByRole('button', {
            name: 'Verificar capacidade do Connector',
            exact: true,
          })
          await expect(async () => {
            if (!(await ready.isVisible())) {
              await expect(verify).toBeEnabled({ timeout: 5000 })
              await verify.click()
            }
            await expect(ready).toBeVisible({ timeout: 10_000 })
          }).toPass({ timeout: 150_000 })
          await page.locator('#onboarding-family').selectOption('bambu-lan')
          await page.locator('#bambu-ip').fill(BAMBU_LAN_ADDRESS)
          await page.locator('#bambu-serial').fill('JOURNEYBAMBU')
          await page.locator('#bambu-access-code').fill(BAMBU_ACCESS_CODE)
          await page.locator('#bambu-control').check()
          await page
            .getByRole('button', { name: 'Preparar Bambu Lab (LAN)' })
            .click()
          await expect(page.locator('#kobra-prepared-heading')).toBeVisible({
            timeout: 60_000,
          })
          await page.locator('#kobra-confirm-checkbox').check()
          await page
            .getByRole('button', { name: 'Confirmar e ativar impressora' })
            .click()
          // The assignment exists only once the Connector signed the commit.
          await expect(
            page.getByText(
              'Impressora adicionada e confirmada com recibo assinado pelo Connector.',
            ),
          ).toBeVisible({ timeout: 90_000 })
        },
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('completa a jornada Bambu no navegador com resultados confirmados ou desconhecidos', async () => {
      // Thirteen Connector sessions, each opened only after the previous one
      // closed (about 30 s apart), plus a timed print and its history entry.
      test.setTimeout(15 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      await journey.expectLiveTelemetry()
      const printer = row(page)
      await expect(printer).toContainText(
        'Atribuição ativa. Connector aprovado.',
      )
      await expect(printer.getByLabel('Trabalho atual')).toContainText('25/100')
      await expect(printer.getByLabel('Temperaturas observadas')).toContainText(
        '210 °C',
      )
      journey.controls.setProgress(60)
      await journey.expectProgress(0.6)

      await lifecycle(
        page,
        'Pausar',
        'Confirmar pausa',
        'Impressão pausada. O Connector confirmou a pausa.',
      )
      expect(simulator().gcodeState).toBe('PAUSE')
      await expect(printer).toContainText('Pausada')
      await lifecycle(
        page,
        'Retomar',
        'Confirmar retomada',
        'Impressão retomada. O Connector confirmou a retomada.',
      )
      expect(simulator().gcodeState).toBe('RUNNING')
      await expect(printer).toContainText('Imprimindo')

      await extendedCommand(page, 'Definir temperatura', async (block) => {
        await block.getByLabel('Aquecedor').selectOption('extruder')
        await block.getByLabel('Temperatura em °C').fill('215')
      })
      await extendedCommand(page, 'Definir ventilador', async (block) => {
        await block.getByLabel('Ventilador').selectOption('part')
        await block.getByLabel('Velocidade em %').fill('50')
      })
      await extendedCommand(page, 'Referenciar eixos')
      await extendedCommand(page, 'Definir luz', async (block) => {
        await block.getByLabel('Luz').selectOption('on')
      })
      await extendedCommand(page, 'Definir velocidade', async (block) => {
        await block.getByLabel('Velocidade').selectOption('sport')
      })
      // Bambu loads into a named AMS tray (AMS 1, tray 1 is tray 0).
      await filamentCommand(page, 'Carregar filamento', async (section) => {
        await section.getByLabel('Bandeja AMS').selectOption('0')
      })
      await filamentCommand(page, 'Descarregar filamento')

      for (const name of [
        'pause',
        'resume',
        'gcode_line',
        'ledctrl',
        'print_speed',
        'ams_change_filament',
      ])
        expect(
          simulator().requests.map((request) => request.command),
        ).toContain(name)
      await lifecycle(
        page,
        'Cancelar',
        'Confirmar cancelamento',
        'Impressão cancelada. O Connector confirmou o cancelamento.',
      )
      expect(simulator().gcodeState).toBe('IDLE')

      await page.goto(journey.origin + '/arquivos', {
        waitUntil: 'domcontentloaded',
      })
      const printers = page.locator('#files-printer')
      await expect(
        printers.locator(`option[value="${journey.assignmentId}"]`),
      ).toBeAttached({ timeout: 30_000 })
      await printers.selectOption(journey.assignmentId)
      const input = page.locator('#files-upload')
      await expect(input).toBeEnabled({ timeout: 30_000 })
      await controlInbox()
      await page.getByRole('button', { name: 'Consultar arquivos' }).click()
      const fileOption = page.locator('#files-existing option', {
        hasText: FILE,
      })
      await expect(fileOption).toHaveCount(0)

      await input.setInputFiles({
        name: FILE,
        mimeType: 'text/plain',
        buffer: GCODE,
      })
      // The listing session has ended; upload in the next one.
      await controlInbox()
      await page.getByRole('button', { name: 'Enviar arquivo' }).click()
      const status = page.getByRole('status').last()
      await expect(status).toHaveText(
        'Arquivo enviado. Selecione-o e confirme para iniciar a impressão.',
        { timeout: 60_000 },
      )
      expect(simulator().uploads.get(FILE)).toEqual(GCODE)

      await controlInbox()
      await page.getByRole('button', { name: 'Consultar arquivos' }).click()
      await expect(fileOption).toHaveCount(1, { timeout: 45_000 })
      // The listing session has ended; start in the next one. The page clears
      // its confirmation whenever the live view blips, so confirm last.
      await controlInbox()
      await page.locator('#files-existing').selectOption(FILE)
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Iniciar impressão' }).click()
      await expect(status).toHaveText(UNKNOWN, { timeout: 60_000 })
      expect(simulator().requests.map((request) => request.command)).toContain(
        'project_file',
      )

      const farmRow = await journey.openFarm()
      await expect(farmRow.getByText('Concluído', { exact: true })).toBeVisible(
        {
          timeout: 60_000,
        },
      )
      await expect(farmRow.getByLabel('Último trabalho')).toContainText(FILE)
      expect(simulator().gcodeState).toBe('FINISH')
      await historyEntry(page, 'Concluído')
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })
    })
  })
