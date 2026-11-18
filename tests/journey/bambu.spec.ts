import { expect, test, type Page } from '@playwright/test'
import type { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

type BambuSim = Awaited<ReturnType<typeof startBambuSimulator>>
const UNKNOWN =
  'Resultado desconhecido. Verifique a impressora antes de tentar novamente.'
const GCODE = Buffer.from('; jornada Bambu\nG28\nG1 X10 Y10 F3000\n')
const FILE = 'jornada-bambu.gcode'

if (journeyEnabled())
  test.describe('journey: Bambu Lab', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined
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

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(5 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'bambu',
        control: true,
        signedControl: true,
        history: true,
        setup: async ({ page, origin }) => {
          await page.goto(origin + '/impressoras', {
            waitUntil: 'domcontentloaded',
          })
          await page.locator('#onboarding-family').selectOption('bambu-lan')
          await page.locator('#bambu-ip').fill('127.0.0.1')
          await page.locator('#bambu-serial').fill('JOURNEYBAMBU')
          await page.locator('#bambu-access-code').fill('journey-access')
          await page.locator('#bambu-control').check()
          await page
            .getByRole('button', { name: 'Preparar Bambu Lab (LAN)' })
            .click()
          await expect(page.locator('#kobra-prepared-heading')).toBeVisible()
          await page.locator('#kobra-confirm-checkbox').check()
          await page
            .getByRole('button', { name: 'Confirmar e ativar impressora' })
            .click()
        },
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('configura no navegador, acompanha telemetria e anuncia resultados honestos', async () => {
      test.setTimeout(5 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      await journey.expectLiveTelemetry()
      const printer = row(page)
      await expect(printer).toContainText(
        'Atribuição ativa. Connector aprovado.',
      )
      await expect(printer.getByLabel('Trabalho atual')).toContainText('25/100')

      // Every Bambu action advertised by the farm is present. MQTT delivery
      // acknowledgements do not prove the printer applied an action, so the
      // UI must retain its explicit unknown outcome after each send.
      const controls = printer.getByRole('region', {
        name: 'Controles adicionais de ' + journey.printerKey,
      })
      for (const label of [
        'Definir temperatura',
        'Definir ventilador',
        'Referenciar eixos',
        'Definir luz',
        'Definir velocidade',
        'Carregar filamento',
        'Descarregar filamento',
      ])
        await expect(
          controls.getByRole('button', { name: label }),
        ).toBeVisible()

      await journey.controls.setProgress(60)
      await journey.expectProgress(0.6)
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })

      // Bambu file transfer is currently not wired as a Connector file target.
      // Prove that upload is reported unsupported; don't seed the simulator
      // or claim a browser upload/start that did not happen.
      await page.goto(journey.origin + '/arquivos', {
        waitUntil: 'domcontentloaded',
      })
      const select = page.locator('#files-printer')
      await expect(
        select.locator('option', { hasText: journey.printerKey }),
      ).toHaveCount(1)
      await select.selectOption(journey.assignmentId)
      const input = page.locator('#files-upload')
      await expect(input).toBeDisabled()
      expect(GCODE.length).toBeGreaterThan(0)
      expect(FILE).toContain('.gcode')
      expect(simulator().gcodeState).toBe('RUNNING')
    })
  })
