import { expect, test, type Locator, type Page } from '@playwright/test'
import type { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. The whole Anycubic (LAN) journey in a real
// browser against the loopback simulator: find, assignment, live telemetry,
// every advertised command, the unsupported file steps, starting a stored
// file, the job end card and the history entries. Never a physical printer.
type Simulator = Awaited<ReturnType<typeof startAnycubicSimulator>>

const STORED_FILE = 'journey.gcode'
// The Connector confirms only pause, resume and cancel, by the print state
// they lead to. Any other command it sends ends as an unknown outcome and the
// page says to check the printer, which each step below does.
const UNKNOWN =
  /^Resultado desconhecido\. Verifique a impressora antes de tentar novamente\./

/**
 * Commands beyond pause, resume and cancel. Each runs against its own
 * Connector: its unknown outcome stays in the Connector's command journal and
 * every later command for that printer is refused.
 */
type Extended = Readonly<{
  title: string
  button: string
  fill(section: Locator): Promise<void>
  /** What the simulator must have been told. */
  settings: Readonly<Record<string, unknown>>
  /** Where the card shows the new value, when the printer reports it back. */
  card?: Readonly<{ label: string; text: string }>
}>
const EXTENDED: readonly Extended[] = [
  {
    title: 'definir temperatura',
    button: 'Definir temperatura',
    async fill(section) {
      await section.getByLabel('Aquecedor').selectOption('extruder')
      await section.getByLabel('Temperatura em °C').fill('215')
    },
    settings: { target_nozzle_temp: 215 },
    card: { label: 'Temperaturas observadas', text: '215 °C' },
  },
  {
    title: 'definir ventilador',
    button: 'Definir ventilador',
    async fill(section) {
      await section.getByLabel('Ventilador').selectOption('part')
      await section.getByLabel('Velocidade em %').fill('50')
    },
    settings: { fan_speed_pct: 50 },
    card: { label: 'Ventilação e iluminação', text: '50' },
  },
  {
    title: 'definir luz',
    button: 'Definir luz',
    async fill(section) {
      await section.getByLabel('Luz').selectOption('on')
    },
    settings: { light: { status: 1 } },
  },
]

if (journeyEnabled()) {
  suite('journey: Anycubic (LAN)')
  for (const extra of EXTENDED)
    suite('journey: Anycubic (LAN), ' + extra.title, extra)
}

function suite(title: string, extra?: Extended) {
  test.describe(title, () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    const simulator = () => {
      const raw = started().vendor?.raw
      if (!raw) throw new Error('Anycubic simulator missing')
      return raw as Simulator
    }
    /** Prints the Connector and app diagnostics when a step fails. */
    async function step(work: () => Promise<void>) {
      try {
        await work()
      } catch (error) {
        const journey = started()
        // The card's own words say why a control is unavailable.
        console.error(
          await printerRow(journey.ownerPage)
            .innerText({ timeout: 2000 })
            .then(
              (text) => text.replace(/\s+/g, ' '),
              () => 'printer card not on the page',
            ),
        )
        console.error(
          JSON.stringify(journey.simulatorObservation()),
          JSON.stringify(simulator().lifecycle),
          journey.appLog(),
        )
        throw error
      }
    }
    const printerRow = (page: Page) =>
      page.getByRole('article').filter({
        has: page.getByRole('heading', {
          name: started().printerKey,
          exact: true,
        }),
      })
    /**
     * The direct session lasts 30 s and the page reopens it by itself, but it
     * stops after six failed reopens in a row. When the connection does not
     * come back, the page is loaded again, as a person would do.
     */
    async function live(page: Page) {
      const connected = printerRow(page).getByText(
        'Conexão direta autenticada',
        { exact: true },
      )
      for (let reload = 0; reload < 8; reload++) {
        if (
          await expect(connected)
            .toBeVisible({ timeout: 30_000 })
            .then(
              () => true,
              () => false,
            )
        )
          return
        await started().openFarm(page)
      }
      throw new Error('The direct connection never came back')
    }
    /** Waits until the live row shows a printer state. */
    async function expectState(row: Locator, label: string) {
      await expect(async () => {
        await live(row.page())
        await expect(row.getByText(label, { exact: true })).toBeVisible({
          timeout: 10_000,
        })
      }).toPass({ timeout: 300_000 })
    }
    /**
     * Opens a command dialog, confirms it, waits for its settled outcome and
     * closes it. Nothing is sent before the confirmation click. The live
     * session is renewed every 30 s, so an authorization that fails with
     * "Nenhum comando foi enviado" is closed and asked for again, as a person
     * would; a sent command is never repeated.
     */
    async function command(
      page: Page,
      open: () => Promise<void>,
      confirm: string,
    ) {
      const dialog = page.getByRole('dialog')
      const status = dialog.getByRole('status')
      const close = dialog.getByRole('button', { name: 'Fechar', exact: true })
      let last = ''
      for (let attempt = 0; attempt < 15; attempt++) {
        await open()
        await expect(dialog).toBeVisible()
        const button = dialog.getByRole('button', {
          name: confirm,
          exact: true,
        })
        let ready = false
        await expect(async () => {
          last = (await status.innerText()).trim()
          ready = await button.isEnabled()
          if (!ready && !/Nenhum comando foi enviado/.test(last))
            throw new Error('Command dialog not ready: ' + last)
        }).toPass({ timeout: 60_000 })
        if (ready) {
          await button.click()
          await expect(close).toBeVisible({ timeout: 60_000 })
          const outcome = (await status.innerText()).trim()
          await close.click()
          await expect(dialog).toBeHidden()
          // Refused or not sent: nothing reached the printer (the Connector
          // takes one command per printer at a time), so it is asked again.
          if (!/recusado|não enviado|não foi enviado/i.test(outcome))
            return outcome
          last = outcome
          await page.waitForTimeout(5000)
          continue
        }
        await close.click()
        await expect(dialog).toBeHidden()
        // The Connector's control inbox is renewed every 30 s; give it time.
        await page.waitForTimeout(5000)
      }
      throw new Error('Command was never authorized: ' + last)
    }
    /** One lifecycle button on the card (Pausar, Retomar, Cancelar). */
    function lifecycle(page: Page, label: string, confirm: string) {
      const button = printerRow(page)
        .getByRole('group', {
          name: 'Controles da impressora ' + started().printerKey,
        })
        .getByRole('button', { name: label, exact: true })
      return command(
        page,
        async () => {
          await expect(async () => {
            await live(page)
            await expect(button).toHaveAttribute('aria-disabled', 'false', {
              timeout: 10_000,
            })
            await button.click({ timeout: 5000 })
            await expect(page.getByRole('dialog')).toBeVisible({
              timeout: 3000,
            })
          }).toPass({ timeout: 300_000 })
        },
        confirm,
      )
    }
    const extended = (page: Page) =>
      printerRow(page).getByRole('region', {
        name: 'Controles adicionais de ' + started().printerKey,
      })
    /** One extended command: fill its fields, submit, confirm, close. */
    function extendedCommand(
      page: Page,
      label: string,
      fill: (section: Locator) => Promise<void>,
    ) {
      const section = extended(page)
      const button = section.getByRole('button', { name: label, exact: true })
      return command(
        page,
        async () => {
          // The fields are enabled only while the row is live.
          await expect(async () => {
            await live(page)
            await fill(section)
            await expect(button).toBeEnabled({ timeout: 5000 })
            await button.click({ timeout: 5000 })
            // The page ignores a click that lands between two live sessions.
            await expect(page.getByRole('dialog')).toBeVisible({
              timeout: 3000,
            })
          }).toPass({ timeout: 300_000 })
        },
        'Confirmar comando',
      )
    }
    /** Opens Arquivos with the farm, browser device and printer selected. */
    async function openFiles(page: Page) {
      const journey = started()
      const consult = page.getByRole('button', {
        name: 'Consultar arquivos',
        exact: true,
      })
      for (let load = 0; load < 8; load++) {
        await page.goto(journey.origin + '/arquivos', {
          waitUntil: 'domcontentloaded',
        })
        const farm = page.locator('#files-farm')
        await expect(farm).toBeVisible({ timeout: 30_000 })
        if ((await farm.inputValue()) !== journey.farmId)
          await farm.selectOption(journey.farmId)
        const key = page.locator('#files-key')
        await expect(key).toBeVisible({ timeout: 30_000 })
        if ((await key.inputValue()) !== journey.browserKeyId)
          await key.selectOption(journey.browserKeyId)
        const printer = page.locator('#files-printer')
        await expect(
          printer.locator(`option[value="${journey.assignmentId}"]`),
        ).toBeAttached({ timeout: 30_000 })
        await printer.selectOption(journey.assignmentId)
        // Files need the live direct connection and the advertised start.
        if (
          await expect(consult)
            .toBeEnabled({ timeout: 40_000 })
            .then(
              () => true,
              () => false,
            )
        )
          return
      }
      throw new Error('The files page never reached a live printer')
    }
    /**
     * One file operation. Each one opens its own short control session; when
     * the page reports that the direct connection did not complete it, the
     * operation is prepared and asked for again, as the message tells a
     * person to do after checking the printer.
     */
    async function filesStep(
      page: Page,
      prepare: () => Promise<Locator>,
      expected: string | RegExp,
      safeToRepeat: () => boolean = () => true,
      verified: () => boolean = () => true,
    ) {
      const done = filesStatus(page, expected)
      // Not completed, or dropped by the page when the live session ended.
      const failed = filesStatus(
        page,
        /Não foi possível concluir pela conexão direta\.|Operação cancelada neste navegador\./,
      )
      const consult = page.getByRole('button', {
        name: 'Consultar arquivos',
        exact: true,
      })
      for (let attempt = 0; attempt < 15; attempt++) {
        if (!safeToRepeat())
          throw new Error('The printer changed state; not repeating')
        // Reloading is the last resort: the page recovers its live session by
        // itself, and each reload starts the device and farm checks again.
        if (
          !(await expect(consult)
            .toBeEnabled({ timeout: 60_000 })
            .then(
              () => true,
              () => false,
            ))
        )
          await openFiles(page)
        const button = await prepare()
        await expect(button).toBeEnabled({ timeout: 40_000 })
        await button.click()
        await expect(
          done.or(failed).first(),
          'files status: ' +
            (await page.getByRole('status').allInnerTexts()).join(' | '),
        ).toBeVisible({ timeout: 90_000 })
        if ((await done.isVisible()) && verified()) return
        // The Connector's control inbox is renewed every 30 s; give it time.
        await page.waitForTimeout(5000)
      }
      throw new Error('File operation never completed: ' + expected)
    }
    const filesStatus = (page: Page, text: string | RegExp) =>
      page.getByRole('status').filter({ hasText: text })

    function extendedTest(command: Extended) {
      test(`${command.title} reaches the simulator`, async () => {
        test.setTimeout(15 * 60_000)
        await step(async () => {
          const journey = started()
          const page = journey.ownerPage
          const sim = simulator()
          const row = await journey.openFarm()
          await expectState(row, 'Imprimindo')
          await expect(
            extended(page).getByRole('button', {
              name: command.button,
              exact: true,
            }),
          ).toBeVisible()
          expect(
            await extendedCommand(page, command.button, command.fill),
          ).toMatch(UNKNOWN)
          // Checked on the printer, as the page asks.
          expect(sim.settings).toMatchObject(command.settings)
          const card = command.card
          if (card)
            await expect(async () => {
              await live(page)
              await expect(row.getByLabel(card.label)).toContainText(
                card.text,
                { timeout: 10_000 },
              )
            }).toPass({ timeout: 300_000 })
          expect(sim.lifecycle.state).toBe('printing')
          expect(journey.simulatorObservation()).toMatchObject({
            failure: false,
          })
        })
      })
    }
    test.beforeAll(async ({ browser }) => {
      test.setTimeout(20 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'anycubic',
        commands: true,
      })
      // Fields are disabled between live sessions: fail fast and try again.
      harness.ownerPage.setDefaultTimeout(15_000)
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    if (extra) {
      extendedTest(extra)
      return
    }
    test('the printer is found by the Connector probe and listed as assigned', async () => {
      await step(async () => {
        const journey = started()
        // Find: the Connector's own Anycubic probe against the loopback
        // responder. The page cannot reach it: the Connector only probes
        // operator-configured private (RFC 1918) networks, never loopback.
        const discovery = journey.discovery
        if (!discovery) throw new Error('Discovery responder missing')
        expect(await discovery.probe()).toMatchObject({
          vendor: 'anycubic',
          host: '127.0.0.1',
          port: discovery.port,
          name: 'Anycubic Kobra 3',
        })
        // Set up: the assignment is visible and active on the printers page.
        const page = journey.ownerPage
        await page.goto(journey.origin + '/impressoras', {
          waitUntil: 'domcontentloaded',
        })
        const farm = page.getByLabel('Farm', { exact: true })
        await expect(farm).toBeVisible({ timeout: 30_000 })
        if ((await farm.inputValue()) !== journey.farmId)
          await farm.selectOption(journey.farmId)
        const assignments = page.locator(
          'section[aria-labelledby="assignment-heading"]',
        )
        await expect(
          assignments.getByText(journey.printerKey, { exact: true }),
        ).toBeVisible({ timeout: 30_000 })
        await expect(
          assignments.getByText('Ativa', { exact: true }),
        ).toBeVisible()
        await expect(
          assignments.getByText('Aprovado', { exact: true }),
        ).toBeVisible()
        // The Anycubic (LAN) setup family is offered by the product.
        await expect(
          page.locator('#onboarding-family option[value="anycubic-lan"]'),
        ).toHaveText('Anycubic (LAN)')
      })
    })

    test('live telemetry follows the simulated print', async () => {
      test.setTimeout(8 * 60_000)
      await step(async () => {
        const journey = started()
        const page = journey.ownerPage
        const row = await journey.openFarm()
        const progress = (fraction: string) =>
          expect(async () => {
            await live(page)
            await expect(row.getByRole('progressbar')).toHaveAttribute(
              'value',
              fraction,
              { timeout: 10_000 },
            )
          }).toPass({ timeout: 300_000 })
        await expectState(row, 'Imprimindo')
        await progress('0.25')
        journey.controls.setProgress(40)
        await progress('0.4')
        // Exactly the Anycubic control set is advertised on the card.
        const group = row.getByRole('group', {
          name: 'Controles da impressora ' + journey.printerKey,
        })
        await expect(group.getByRole('button')).toHaveText([
          'Pausar',
          'Retomar',
          'Cancelar',
        ])
        await expect(
          extended(journey.ownerPage).getByRole('button'),
        ).toHaveText([
          'Definir temperatura',
          'Definir ventilador',
          'Definir luz',
        ])
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      })
    })

    test('pause, resume and cancel reach the simulator', async () => {
      test.setTimeout(25 * 60_000)
      await step(async () => {
        const journey = started()
        const page = journey.ownerPage
        const row = printerRow(page)
        const sim = simulator()

        expect(await lifecycle(page, 'Pausar', 'Confirmar pausa')).toBe(
          'Impressão pausada. O Connector confirmou a pausa.',
        )
        expect(sim.lifecycle.state).toBe('paused')
        await expectState(row, 'Pausada')

        expect(await lifecycle(page, 'Retomar', 'Confirmar retomada')).toBe(
          'Impressão retomada. O Connector confirmou a retomada.',
        )
        expect(sim.lifecycle.state).toBe('printing')
        await expectState(row, 'Imprimindo')

        // Commands the Anycubic library does not document are not offered.
        for (const absent of [
          'Referenciar eixos',
          'Definir velocidade',
          'Reiniciar firmware',
          'Parada de emergência',
          'Carregar filamento',
          'Descarregar filamento',
          'Executar macro',
        ])
          await expect(
            row.getByRole('button', { name: absent, exact: true }),
          ).toHaveCount(0)

        // Cancel ends the scripted print: the first job end card.
        expect(
          await lifecycle(page, 'Cancelar', 'Confirmar cancelamento'),
        ).toMatch(/O Connector confirmou/)
        expect(sim.lifecycle.state).toBe('idle')
        await expectState(row, 'Ociosa')
        await expect(row.getByText('Cancelado', { exact: true })).toBeVisible({
          timeout: 10_000,
        })
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      })
    })

    test('upload and listing are não suportado; a stored file starts printing', async () => {
      test.setTimeout(15 * 60_000)
      await step(async () => {
        const journey = started()
        const page = journey.ownerPage
        const sim = simulator()
        // LAN upload has no documented protocol, so the file is placed on the
        // simulated printer storage directly, as a slicer or USB stick would.
        sim.upload(STORED_FILE, Buffer.from('G28\nG1 X10 Y10\n'))
        await openFiles(page)

        const unlisted =
          'Listagem não suportada pela biblioteca desta impressora.'
        await filesStep(
          page,
          async () => {
            await page.locator('#files-upload').setInputFiles({
              name: 'envio.gcode',
              mimeType: 'text/plain',
              buffer: Buffer.from('G28\n'),
            })
            return page.getByRole('button', {
              name: 'Enviar arquivo',
              exact: true,
            })
          },
          'Envio não suportado pela biblioteca desta impressora.',
        )
        const consult = page.getByRole('button', {
          name: 'Consultar arquivos',
          exact: true,
        })
        await filesStep(page, async () => consult, unlisted)
        expect(sim.lifecycle.state).toBe('idle')

        // Start: the exact name of the stored file, then an explicit check.
        const stored = page.getByLabel('Arquivo armazenado na impressora')
        const start = page.getByRole('button', {
          name: 'Iniciar impressão',
          exact: true,
        })
        await expect(stored).toBeVisible()
        await stored.fill('../' + STORED_FILE)
        await expect(
          page.getByText('Nome inválido para o comando de impressão.'),
        ).toBeVisible()
        await expect(start).toBeDisabled()
        await stored.fill(STORED_FILE)
        await expect(start).toBeDisabled()
        await filesStep(
          page,
          async () => {
            // A reloaded page asks for the listing again before the name.
            if (!(await stored.isVisible())) {
              await expect(consult).toBeEnabled({ timeout: 40_000 })
              await consult.click()
              await expect(stored).toBeVisible({ timeout: 90_000 })
            }
            await stored.fill(STORED_FILE)
            await page
              .getByRole('checkbox', { name: /Quero iniciar esta impressão/ })
              .check()
            return start
          },
          // Unknown outcome: the printer itself says whether it started.
          /Impressão iniciada\. O Connector confirmou o comando\.|Resultado desconhecido\. Verifique a impressora/,
          // Never a second start once the simulated printer left idle.
          () => sim.lifecycle.state === 'idle',
          () => sim.lifecycle.state !== 'idle',
        )
        expect(['printing', 'finished']).toContain(sim.lifecycle.state)
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      })
    })

    test('the job end card and the history entries appear', async () => {
      test.setTimeout(15 * 60_000)
      await step(async () => {
        const journey = started()
        const page = journey.ownerPage
        const sim = simulator()
        // The simulated print runs its own course and completes.
        await expect
          .poll(() => sim.lifecycle.state, { timeout: 60_000 })
          .toBe('finished')
        const row = await journey.openFarm()
        await expectState(row, 'Ociosa')
        await expect(async () => {
          await live(page)
          await expect(row.getByText('Concluído', { exact: true })).toBeVisible(
            { timeout: 10_000 },
          )
          await expect(row.getByLabel('Último trabalho')).toContainText(
            STORED_FILE,
            { timeout: 1000 },
          )
        }).toPass({ timeout: 300_000 })

        // History: recorded by the server from the Connector's telemetry.
        await page.goto(journey.origin + '/historico', {
          waitUntil: 'domcontentloaded',
        })
        await expect(
          page.getByRole('heading', { name: 'Histórico de trabalhos' }),
        ).toBeVisible()
        const farm = page.getByLabel('Farm', { exact: true })
        const refresh = page.getByRole('button', {
          name: 'Atualizar histórico',
          exact: true,
        })
        const jobs = page
          .getByRole('table', { name: 'Trabalhos finalizados' })
          .getByRole('row')
        const completed = jobs.filter({ hasText: 'Concluído' })
        await expect
          .poll(
            async () => {
              if ((await farm.inputValue()) !== journey.farmId)
                await farm.selectOption(journey.farmId)
              else if (await refresh.isEnabled()) await refresh.click()
              await expect(refresh).toBeEnabled({ timeout: 20_000 })
              return completed.count()
            },
            { timeout: 120_000, intervals: [2000] },
          )
          .toBe(1)
        await expect(completed).toContainText(journey.printerKey)
        await expect(completed).toContainText(STORED_FILE)
        const cancelled = jobs.filter({ hasText: 'Cancelado' })
        await expect(cancelled).toHaveCount(1)
        await expect(cancelled).toContainText(journey.printerKey)
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      })
    })
  })
}
