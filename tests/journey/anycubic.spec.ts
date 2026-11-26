import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { discoverOnPage, expectCameraFrames } from './discovery-page.ts'
import {
  journeyEnabled,
  reportedProgress,
  reportedProgressValue,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. The whole Anycubic (LAN) journey in a real
// browser against the loopback simulator: find, assignment, live telemetry,
// every advertised command, file upload and listing, starting a stored
// G-code file, the job end card and the history entries. Never a physical printer.
type Simulator = Awaited<ReturnType<typeof startAnycubicSimulator>>

const STORED_FILE = 'journey.gcode'
const UPLOAD_FILE = fileURLToPath(
  new URL('../fixtures/anycubic/journey.gcode.3mf', import.meta.url),
)
// Pause, resume and cancel are confirmed by the print state they lead to. Any
// other command is confirmed only when the printer's next report carries the
// value that was asked for (target, fan speed, light); each step below also
// checks what the simulator was told.
const APPLIED = 'Comando confirmado pelo Connector.'

/** Commands beyond pause, resume and cancel. */
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
}

function suite(title: string) {
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
      page
        .getByRole('dialog', { name: 'Inspeção da impressora', exact: true })
        .getByRole('article')
        .filter({
          has: page.getByRole('heading', {
            name: started().printerKey,
            exact: true,
          }),
        })
    async function openFarm(page: Page = started().ownerPage) {
      await started().openFarm(page)
      return printerRow(page)
    }
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
            .toBeVisible({ timeout: 60_000 })
            .then(
              () => true,
              () => false,
            )
        )
          return
        await openFarm(page)
      }
      throw new Error('The direct connection never came back')
    }
    /** Waits until the live row shows a printer state. */
    async function expectState(row: Locator, label: string) {
      await expect(async () => {
        await live(row.page())
        const reportedState = row
          .getByText('Último estado informado', { exact: true })
          .locator('xpath=following-sibling::dd[1]')
        await expect(reportedState).toHaveText(label, { timeout: 10_000 })
        await expect(reportedState).toBeVisible()
      }).toPass({ timeout: 300_000 })
    }
    /**
     * Each control session uses one Connector control inbox. Waits for an
     * inbox opened after the last one a command used, on the Connector's own
     * diagnostics, instead of sleeping. When no new one appears (the last
     * attempt never reached the Connector), a listening inbox is enough.
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
          { timeout: 45_000 },
        )
        .toBe(true)
        .catch(() =>
          expect
            .poll(() => observe().pauseInboxReady, { timeout: 45_000 })
            .toBe(true),
        )
      inboxesUsed = observe().pauseInboxes
    }
    /**
     * Opens a command dialog, confirms it, waits for its settled outcome and
     * closes it. Nothing is sent before the confirmation click. The live
     * session is renewed every 30 s, so an authorization that fails with
     * "Nenhum comando foi enviado" is closed and asked for again, as a person
     * would; a sent command is never repeated.
     */
    const commandDialog = (page: Page) =>
      page.locator('dialog[aria-labelledby="pause-dialog-title"]')

    async function command(
      page: Page,
      open: () => Promise<void>,
      confirm: string,
    ) {
      const dialog = commandDialog(page)
      const status = dialog.getByRole('status')
      // "Cancelar" until the command settles or fails, "Fechar" after.
      const close = dialog.getByRole('button', { name: /^(Fechar|Cancelar)$/ })
      let last = ''
      for (let attempt = 0; attempt < 15; attempt++) {
        await controlInbox()
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
          // Settled or failed: only then is the button named "Fechar".
          await expect(
            dialog.getByRole('button', { name: 'Fechar', exact: true }),
          ).toBeVisible({ timeout: 60_000 })
          const outcome = (await status.innerText()).trim()
          await close.click()
          await expect(dialog).toBeHidden()
          // Refused or not sent: nothing reached the printer (the Connector
          // takes one command per printer at a time), so it is asked again.
          if (!/recusado|não enviado|não foi enviado/i.test(outcome))
            return outcome
          last = outcome
          continue
        }
        await close.click()
        await expect(dialog).toBeHidden()
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
            await expect(commandDialog(page)).toBeVisible({
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
            await expect(commandDialog(page)).toBeVisible({
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
        // The page selects the only farm and approved device by itself.
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
     * One file operation per control session. Only listing can be repeated
     * after a dispatch that did not finish.
     */
    async function filesStep(
      page: Page,
      prepare: () => Promise<Locator>,
      expected: string | RegExp,
      readOnly = false,
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
      let preparing = ''
      for (let attempt = 0; attempt < 15; attempt++) {
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
        // Each file operation uses one control session of the Connector.
        await controlInbox()
        // A field disabled between two live sessions is not an error: nothing
        // was sent, so the operation is prepared again.
        let button: Locator
        try {
          button = await prepare()
        } catch (error) {
          preparing = error instanceof Error ? error.message : String(error)
          continue
        }
        // The page clears a confirmation when the live session blinks: the
        // operation is prepared again.
        if (
          !(await expect(button)
            .toBeEnabled({ timeout: 15_000 })
            .then(
              () => true,
              () => false,
            ))
        )
          continue
        await button.click()
        await expect(
          done.or(failed).first(),
          'files status: ' +
            (await page.getByRole('status').allInnerTexts()).join(' | '),
        ).toBeVisible({ timeout: 90_000 })
        if (await done.isVisible()) return
        if (!readOnly) break
      }
      throw new Error(
        'File operation never completed: ' + expected + ' ' + preparing,
      )
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
          // Same page as the step before: loading it again would end the
          // live session and the Connector would have to admit a new one.
          const row = printerRow(page)
          await expectState(row, 'Imprimindo')
          await expect(
            extended(page).getByRole('button', {
              name: command.button,
              exact: true,
            }),
          ).toBeVisible()
          expect(
            await extendedCommand(page, command.button, command.fill),
          ).toBe(APPLIED)
          // Checked on the printer as well.
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
        signedControl: true,
        history: true,
        discovery: true,
        // Stored states can occupy the wall while the direct feed reconnects.
        openFarmInspector: true,
      })
      // Fields are disabled between live sessions: fail fast and try again.
      harness.ownerPage.setDefaultTimeout(15_000)
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('the page finds the printer through discovery and lists it as assigned', async () => {
      test.setTimeout(8 * 60_000)
      await step(async () => {
        const journey = started()
        // Find: "Procurar impressoras" on Impressoras, answered by the
        // Connector's own Anycubic probe against the loopback responder; the
        // selected result prefills the set-up form.
        await discoverOnPage(journey, {
          family: 'anycubic-lan',
          label: 'Anycubic Kobra 3',
          hostField: 'anycubic-host',
        })
        // Set up: the assignment is visible and active on the printers page.
        const page = journey.ownerPage
        const assignments = page.locator(
          'section[aria-labelledby="assignment-heading"]',
        )
        const assignmentRow = assignments.getByRole('row').filter({
          has: page.getByRole('rowheader', {
            name: journey.printerKey,
            exact: true,
          }),
        })
        await expect(assignmentRow).toBeVisible({ timeout: 30_000 })
        await expect(
          assignmentRow.getByRole('cell', { name: 'Ativa', exact: true }),
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
        const row = await openFarm()
        const progress = (fraction: string) =>
          expect(async () => {
            await live(page)
            await expect(reportedProgress(row)).toHaveAttribute(
              'aria-valuenow',
              reportedProgressValue(fraction),
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

    test('shows the remaining print time reported over Anycubic LAN', async () => {
      test.setTimeout(8 * 60_000)
      await step(async () => {
        const journey = started()
        const sim = simulator()
        const page = journey.ownerPage
        journey.setTelemetryUpload(false)
        const remaining = printerRow(page)
          .getByLabel('Trabalho atual')
          .getByText('Tempo restante estimado', { exact: true })
          .locator('xpath=following-sibling::dd[1]')
        const expectRemaining = (text: string) =>
          expect(async () => {
            await live(page)
            await expect(remaining).toHaveText(text, { timeout: 10_000 })
            await expect(remaining).toBeVisible()
          }).toPass({ timeout: 300_000 })

        try {
          sim.setRemainingMinutes(92)
          await openFarm(page)
          await expectRemaining('1 h 32 min')
          sim.setRemainingMinutes(0)
          await expectRemaining('0 h 0 min')
        } finally {
          sim.setRemainingMinutes(undefined)
          journey.setTelemetryUpload(true)
        }
      })
    })

    for (const extra of EXTENDED) extendedTest(extra)

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

        // Commands the Anycubic library does not document are not offered:
        // the card names each one as não suportado.
        const unsupported = extended(page).getByRole('term')
        await expect(unsupported).toHaveText([
          'Referenciar eixos',
          'Definir velocidade',
          'Reiniciar firmware',
          'Parada de emergência',
          'Carregar filamento',
          'Descarregar filamento',
        ])
        await expect(
          extended(page)
            .getByRole('definition')
            .filter({
              hasText: /^Não suportado$/,
            }),
        ).toHaveCount(6)
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

    test('uploads and lists a package, then starts a stored G-code file', async () => {
      test.setTimeout(15 * 60_000)
      await step(async () => {
        const journey = started()
        const page = journey.ownerPage
        const sim = simulator()
        sim.upload(STORED_FILE, Buffer.from('G28\nG1 X10 Y10\n'))
        await openFiles(page)

        const uploadsBefore = sim.uploadCount
        await filesStep(
          page,
          async () => {
            await page.locator('#files-upload').setInputFiles(UPLOAD_FILE)
            return page.getByRole('button', {
              name: 'Enviar arquivo',
              exact: true,
            })
          },
          /Arquivo enviado\./,
        )
        expect(sim.uploadCount).toBe(uploadsBefore + 1)
        expect(sim.lifecycle.state).toBe('idle')

        const consult = page.getByRole('button', {
          name: 'Consultar arquivos',
          exact: true,
        })
        await filesStep(
          page,
          async () => consult,
          'Arquivos atualizados.',
          true,
        )
        const stored = page.getByLabel('Arquivo para imprimir')
        await expect(
          stored.locator('option[value="journey.gcode.3mf"]'),
        ).toBeAttached()
        const start = page.getByRole('button', {
          name: 'Iniciar impressão',
          exact: true,
        })
        await filesStep(
          page,
          async () => {
            await stored.selectOption(STORED_FILE)
            await expect(start).toBeDisabled()
            await page
              .getByRole('checkbox', { name: /Quero iniciar esta impressão/ })
              .check()
            return start
          },
          /Impressão iniciada\. O Connector confirmou o comando\./,
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
        const row = await openFarm()
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

    test('the farm page shows decoded camera frames from the printer', async () => {
      test.setTimeout(5 * 60_000)
      await step(async () => {
        const journey = started()
        // A fresh farm page: the camera runs after every control step.
        // The camera track rides the direct connection, so its 15 s budget
        // starts once that connection is up, not while it is being set up.
        await openFarm()
        await live(journey.ownerPage)
        await expectCameraFrames(journey)
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      })
    })
  })
}
