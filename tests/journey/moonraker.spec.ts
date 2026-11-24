import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  journeyEnabled,
  reportedPrintProgressBar,
  reportedProgressValue,
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
        openFarmInspector: true,
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
        // expectLiveTelemetry opened /farm; keep its live connection.
        const row = journey.farmRow()
        await expect(row).toContainText('Conexão direta autenticada')
        await expect(reportedPrintProgressBar(row)).toHaveAttribute(
          'aria-valuenow',
          reportedProgressValue(0.25),
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

if (journeyEnabled())
  test('mostra telemetria e controla a temperatura da Snapmaker U1 simulada', async ({
    browser,
  }) => {
    test.setTimeout(5 * 60_000)
    const journey = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
      openFarmInspector: true,
      signedControl: true,
      history: true,
      moonraker: {
        mock: {
          profile: 'u1',
          // The Connector reads each heater's configured ceiling before it
          // writes a tool temperature.
          configfileSettings: {
            extruder: { max_temp: 300 },
            extruder1: { max_temp: 300 },
            extruder2: { max_temp: 300 },
            extruder3: { max_temp: 300 },
          },
        },
        declaredModel: 'Snapmaker U1',
      },
    })
    try {
      const printer = journey.printer.control
      const page = journey.ownerPage
      printer.update({
        activeExtruder: 'extruder2',
        extruders: {
          extruder: { temperature: 210, target: 40 },
          extruder1: { temperature: 220, target: 41 },
          extruder2: { temperature: 230, target: 42 },
          extruder3: { temperature: 245, target: 43 },
        },
        bedTarget: 55,
      })

      // The issuer grants only persisted advertised controls: wait for the
      // Connector's telemetry before opening the single-use control peer.
      await expect
        .poll(() => journey.advertisedControls(), { timeout: 90_000 })
        .toContain('set_tool_temperature')
      journey.setTelemetryUpload(false)
      await journey.expectLiveTelemetry()
      const row = journey.farmRow()
      printer.update({ state: 'standby' })
      await expect(row).toContainText('Ociosa', { timeout: 60_000 })
      expect(journey.printer.subscriptionObjects()).toContainEqual(
        expect.objectContaining({
          extruder1: ['temperature', 'target'],
          extruder2: ['temperature', 'target'],
          extruder3: ['temperature', 'target'],
          toolhead: ['extruder'],
        }),
      )
      const temperatures = row.getByLabel('Temperaturas observadas')
      await expect(temperatures).toContainText('230 °C')
      await expect(temperatures).toContainText('60 °C')

      await expect
        .poll(
          () => {
            const { pauseInboxReady, pauseInboxes } =
              journey.simulatorObservation()
            return pauseInboxReady && pauseInboxes > 0
          },
          { timeout: 90_000 },
        )
        .toBe(true)
      const extended = row.getByRole('region', {
        name: 'Controles adicionais de ' + journey.printerKey,
      })
      const toolTwoInput = extended.getByLabel(
        'Ferramenta 3 — Temperatura em °C',
      )
      await expect(toolTwoInput).toBeVisible({ timeout: 10_000 })
      const setToolTwo = extended.getByRole('button', {
        name: 'Definir temperatura da Ferramenta 3',
        exact: true,
      })
      await toolTwoInput.fill('222')
      await expect(setToolTwo).toBeEnabled()
      await setToolTwo.click()

      const dialog = page.getByRole('dialog', {
        name: new RegExp(journey.printerKey),
      })
      await expect(dialog).toBeVisible()
      await expect(
        dialog.getByText(
          'Confirme a temperatura de 222 °C para a Ferramenta 3.',
        ),
      ).toBeVisible()
      const confirm = dialog.getByRole('button', {
        name: 'Confirmar comando',
        exact: true,
      })
      await expect(confirm).toBeEnabled({ timeout: 45_000 })
      await confirm.click()
      await expect(dialog.getByRole('status')).toHaveText(
        'Comando confirmado pelo Connector.',
        { timeout: 60_000 },
      )
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
      await expect(dialog).toBeHidden()

      await expect
        .poll(() => printer.model().extruders.extruder2?.target)
        .toBe(222)
      expect(printer.model().extruders).toMatchObject({
        extruder: { target: 40 },
        extruder1: { target: 41 },
        extruder3: { target: 43 },
      })
      expect(printer.model().bedTarget).toBe(55)
      expect(printer.gcodeScripts).toEqual([
        'SET_HEATER_TEMPERATURE HEATER=extruder2 TARGET=222',
      ])
      // Exactly one write reached the fixture: the signed tool temperature.
      const calls = journey.printer.calls()
      expect(calls['printer.gcode.script']).toBe(1)
      expect(
        Object.fromEntries(
          PRINT_CALLS.map((method) => [method, calls[method] ?? 0]),
        ),
      ).toEqual({
        'printer.print.start': 0,
        'printer.print.pause': 0,
        'printer.print.resume': 0,
        'printer.print.cancel': 0,
        'printer.emergency_stop': 0,
        'printer.gcode.script': 1,
      })

      printer.update({
        extruders: { extruder2: { temperature: 231, target: 222 } },
      })
      await expect(temperatures).toContainText('231 °C', { timeout: 60_000 })
      await expect(row).toContainText('Conexão direta autenticada')

      printer.update({ activeExtruder: 'extruder3' })
      await expect(temperatures).toContainText('245 °C')

      printer.update({ activeExtruder: 'extruder' })
      await expect(temperatures).toContainText('210 °C')

      printer.update({ activeExtruder: 'extruder9' })
      await expect(temperatures).toContainText('Indisponível')
      await expect(temperatures).toContainText('60 °C')
      // The reported progress ring is only drawn while a job is printing.
      printer.update({ state: 'printing' })
      await journey.expectProgress(0.25)
      expect(printer.gcodeScripts).toEqual([
        'SET_HEATER_TEMPERATURE HEATER=extruder2 TARGET=222',
      ])
    } finally {
      await journey.close()
    }
  })

// Authorized direct WebRTC lifecycle commands against the loopback Moonraker
// fixture. Every command is signed in the browser and travels over its own
// direct connection; nothing here calls the fixture's RPC surface. The fixture
// records what reaches it, so each assertion pairs the page outcome with the
// exact `printer.print.*` call count and an empty G-code log.
const NOT_SENT = /Nenhum comando foi enviado\./
const RESULT = {
  pause: 'Impressão pausada. O Connector confirmou a pausa.',
  resume: 'Impressão retomada. O Connector confirmou a retomada.',
  cancel: 'Impressão cancelada. O Connector confirmou o cancelamento.',
} as const
const PRINT_CALLS = [
  'printer.print.start',
  'printer.print.pause',
  'printer.print.resume',
  'printer.print.cancel',
  'printer.emergency_stop',
  'printer.gcode.script',
] as const

const lifecycleProfiles = [
  { name: 'journey: Moonraker lifecycle controls' },
  {
    name: 'journey: Moonraker lifecycle controls (Snapmaker U1)',
    moonraker: { mock: { profile: 'u1' }, declaredModel: 'Snapmaker U1' },
  },
] as const

for (const profile of journeyEnabled() ? lifecycleProfiles : [])
  test.describe(profile.name, () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    const printerRow = (page: Page) => started().farmRow(page)
    const controls = (page: Page) =>
      printerRow(page).getByRole('group', {
        name: 'Controles da impressora ' + started().printerKey,
      })
    const button = (page: Page, label: string) =>
      controls(page).getByRole('button', { name: label, exact: true })
    const reportedState = (row: Locator, label: string) =>
      expect(
        row
          .locator('dt', { hasText: 'Último estado informado' })
          .locator('+ dd'),
      ).toHaveText(label, { timeout: 30_000 })
    /** Fixture RPC counts for every state-changing or G-code method. */
    const written = () => {
      const calls = started().printer.calls()
      return Object.fromEntries(
        PRINT_CALLS.map((method) => [method, calls[method] ?? 0]),
      )
    }

    // Each signed command consumes one control session of the Connector, which
    // then needs a moment to listen again; an early attempt fails closed with
    // nothing sent, so the journey waits for a fresh control inbox first.
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

    async function lifecycle(
      page: Page,
      action: keyof typeof RESULT,
      label: string,
      confirm: string,
    ) {
      // The command dialog is titled with the printer; the inspector is not.
      const dialog = page.getByRole('dialog', {
        name: new RegExp(started().printerKey),
      })
      const status = dialog.getByRole('status')
      const confirmation = dialog.getByRole('button', {
        name: confirm,
        exact: true,
      })
      for (let attempt = 1; ; attempt++) {
        await controlInbox()
        await expect(button(page, label)).toHaveAttribute(
          'aria-disabled',
          'false',
          { timeout: 20_000 },
        )
        await button(page, label).click()
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
        await dialog
          .getByRole('button', { name: 'Fechar', exact: true })
          .click()
        await expect(dialog).toBeHidden()
      }
      await confirmation.click()
      await expect(status).toHaveText(RESULT[action], { timeout: 45_000 })
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
      await expect(dialog).toBeHidden()
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(5 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'moonraker-fixture',
        openFarmInspector: true,
        signedControl: true,
        ...('moonraker' in profile ? { moonraker: profile.moonraker } : {}),
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('idle printer: lifecycle commands are unavailable and nothing is sent', async () => {
      test.setTimeout(3 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      await journey.expectLiveTelemetry()
      const row = printerRow(page)
      await expect(row).toContainText('Conexão direta autenticada')
      // Safe idle: the printer reports standby, so no lifecycle command applies.
      journey.printer.update({ state: 'standby', progress: 0 })
      await reportedState(row, 'Ociosa')
      await expect(controls(page)).toBeVisible({ timeout: 60_000 })
      for (const [label, why] of [
        ['Pausar', 'A impressora não está imprimindo.'],
        ['Retomar', 'A impressão não está pausada.'],
        ['Cancelar', 'A impressora não está imprimindo nem pausada.'],
      ] as const) {
        const control = button(page, label)
        await expect(control).toHaveAttribute('aria-disabled', 'true')
        await expect(controls(page)).toContainText(why)
      }
      expect(written()).toEqual(
        Object.fromEntries(PRINT_CALLS.map((method) => [method, 0])),
      )
      expect(journey.printer.control.gcodeScripts).toEqual([])
    })

    test('printing: pause and cancel are offered; pause and resume reach the fixture once', async () => {
      test.setTimeout(5 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      const row = printerRow(page)
      journey.printer.update({ state: 'printing', progress: 0.25 })
      await reportedState(row, 'Imprimindo')
      await expect(button(page, 'Pausar')).toHaveAttribute(
        'aria-disabled',
        'false',
        { timeout: 30_000 },
      )
      await expect(button(page, 'Retomar')).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      await expect(button(page, 'Cancelar')).toHaveAttribute(
        'aria-disabled',
        'false',
      )

      await lifecycle(page, 'pause', 'Pausar', 'Confirmar pausa')
      expect(journey.printer.model().state).toBe('paused')
      expect(written()).toMatchObject({
        'printer.print.pause': 1,
        'printer.print.resume': 0,
        'printer.print.cancel': 0,
      })
      await reportedState(row, 'Pausada')
      await expect(button(page, 'Pausar')).toHaveAttribute(
        'aria-disabled',
        'true',
      )

      await lifecycle(page, 'resume', 'Retomar', 'Confirmar retomada')
      expect(journey.printer.model().state).toBe('printing')
      expect(written()).toMatchObject({
        'printer.print.pause': 1,
        'printer.print.resume': 1,
        'printer.print.cancel': 0,
      })
      await reportedState(row, 'Imprimindo')
    })

    test('cancel ends the job and nothing else is written', async () => {
      test.setTimeout(5 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      const row = printerRow(page)
      await lifecycle(page, 'cancel', 'Cancelar', 'Confirmar cancelamento')
      expect(journey.printer.model().state).toBe('cancelled')
      expect(written()).toEqual({
        'printer.print.start': 0,
        'printer.print.pause': 1,
        'printer.print.resume': 1,
        'printer.print.cancel': 1,
        'printer.emergency_stop': 0,
        'printer.gcode.script': 0,
      })
      const calls = journey.printer.calls()
      for (const method of PRINT_CALLS) {
        const request = 'HTTP POST /' + method.replaceAll('.', '/')
        expect(calls[request] ?? 0, request).toBe(0)
      }
      expect(journey.printer.control.gcodeScripts).toEqual([])
      await expect(row.getByText('Cancelado', { exact: true })).toBeVisible({
        timeout: 60_000,
      })
      // A cancelled job leaves the printer idle: every lifecycle command is
      // unavailable again.
      for (const label of ['Pausar', 'Retomar', 'Cancelar'])
        await expect(button(page, label)).toHaveAttribute(
          'aria-disabled',
          'true',
          { timeout: 30_000 },
        )
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })
    })
  })

// Browser file upload over an authorized direct WebRTC control session against
// the loopback Moonraker fixture. The page offers the file to the Connector,
// which stores it through the fixture's own `/server/files/upload` endpoint;
// nothing here calls the fixture's HTTP surface. Assertions pair the page
// outcome with the bytes and name the fixture stored, and with a listing read
// back by a fresh page.
const UPLOAD = 'peca-moonraker.gcode'
const UPLOAD_BYTES = Buffer.from('; journey\nG28\nG1 X10 Y10 F3000\nM84\n')
const UPLOADED =
  'Arquivo enviado. Selecione-o e confirme para iniciar a impressão.'
const LISTED = 'Arquivos atualizados.'
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

if (journeyEnabled())
  test.describe('journey: Moonraker file upload', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    /** Fixture request counts for every method that could change the printer. */
    const written = () => {
      const calls = started().printer.calls()
      return Object.fromEntries(
        PRINT_CALLS.map((method) => [method, calls[method] ?? 0]),
      )
    }

    // Each signed file operation consumes one control session of the
    // Connector, which then needs a moment to listen again; an early attempt
    // fails closed with nothing sent, so the journey waits for a fresh inbox.
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

    /** Opens the files page with the journey printer selected. */
    async function openFiles(page: Page) {
      const journey = started()
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
      await expect(page.locator('#files-upload')).toBeEnabled({
        timeout: 45_000,
      })
    }

    // Listing is read-only and can be retried on a fresh control session.
    async function fileOperation(page: Page, label: string, result: string) {
      const undone = [
        'Não foi possível concluir pela conexão direta. Verifique a impressora antes de tentar novamente.',
        'Operação cancelada neste navegador. Confira o estado da impressora e seus arquivos antes de tentar novamente.',
      ]
      const settled = new RegExp(
        `^(${[result, ...undone].map(escapeRegExp).join('|')})$`,
      )
      const status = page.getByRole('status').last()
      for (let attempt = 1; ; attempt++) {
        await controlInbox()
        await expect(page.locator('#files-upload')).toBeEnabled({
          timeout: 45_000,
        })
        await page.getByRole('button', { name: label, exact: true }).click()
        await expect(status).toHaveText(settled, { timeout: 60_000 })
        const text = (await status.textContent()) ?? ''
        if (text === result) return
        expect(attempt, text).toBeLessThan(5)
      }
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(5 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'moonraker-fixture',
        openFarmInspector: true,
        signedControl: true,
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('uploads a file over the direct connection, stores it and lists it', async () => {
      test.setTimeout(6 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      try {
        await journey.expectLiveTelemetry()
        // Safe idle: uploading needs no running job, and none is touched.
        journey.printer.update({ state: 'standby', progress: 0 })
        await openFiles(page)

        await fileOperation(
          page,
          'Consultar arquivos',
          'Nenhum arquivo nesta impressora.',
        )
        expect([...journey.printer.control.files.keys()]).toEqual([])

        await page.locator('#files-upload').setInputFiles({
          name: UPLOAD,
          mimeType: 'text/plain',
          buffer: UPLOAD_BYTES,
        })
        await controlInbox()
        await expect(page.locator('#files-upload')).toBeEnabled({
          timeout: 45_000,
        })
        await page
          .getByRole('button', { name: 'Enviar arquivo', exact: true })
          .click()
        await expect(page.getByRole('status').last()).toHaveText(UPLOADED, {
          timeout: 60_000,
        })

        // The fixture's own upload endpoint stored exactly what the browser
        // sent, under the name it sent.
        expect(journey.printer.calls()['HTTP POST /server/files/upload']).toBe(
          1,
        )
        expect([...journey.printer.control.files.keys()]).toEqual([
          `gcodes:${UPLOAD}`,
        ])
        const stored = journey.printer.control.files.get(`gcodes:${UPLOAD}`)
        expect(stored).toMatchObject({
          path: UPLOAD,
          root: 'gcodes',
          size: UPLOAD_BYTES.length,
        })
        expect(stored?.content.equals(UPLOAD_BYTES)).toBe(true)

        // A fresh page forgets the local post-upload entry, so the listing
        // below can only come from the printer.
        await openFiles(page)
        await expect(page.locator('#files-existing')).toHaveCount(0)
        const listings = () =>
          journey.printer.calls()['HTTP GET /server/files/list'] ?? 0
        const before = listings()
        await fileOperation(page, 'Consultar arquivos', LISTED)
        expect(listings()).toBeGreaterThan(before)
        await expect(
          page.locator('#files-existing').locator('option', {
            hasText: new RegExp(
              `^${escapeRegExp(UPLOAD)} \\(${UPLOAD_BYTES.length} bytes\\)$`,
            ),
          }),
        ).toHaveCount(1)

        // Uploading starts nothing: no lifecycle or G-code call, and the
        // printer stays idle.
        expect(written()).toEqual(
          Object.fromEntries(PRINT_CALLS.map((method) => [method, 0])),
        )
        expect(written()).toEqual(
          Object.fromEntries(PRINT_CALLS.map((method) => [method, 0])),
        )
        const calls = journey.printer.calls()
        for (const method of PRINT_CALLS) {
          const request = 'HTTP POST /' + method.replaceAll('.', '/')
          expect(calls[request] ?? 0, request).toBe(0)
        }
        expect(journey.printer.control.gcodeScripts).toEqual([])
        expect(journey.printer.model().state).toBe('standby')
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      } catch (error) {
        console.error(
          JSON.stringify(journey.simulatorObservation()),
          journey.appLog(),
        )
        throw error
      }
    })
  })

// The Connector reads `server.history.list` from the printer's Moonraker
// (its HTTP twin) when the live connection first reports a state, and stores
// each finished job it has not seen live. A job seeded only in the fixture's
// history therefore reaches the history page, which proves the import path.
const SEEDED = 'historico-importado.gcode'

if (journeyEnabled())
  test('importa um trabalho do histórico do Moonraker e o mostra no histórico', async ({
    browser,
  }) => {
    test.setTimeout(6 * 60_000)
    const now = Math.floor(Date.now() / 1000)
    const journey = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
      openFarmInspector: true,
      history: true,
      moonraker: {
        mock: {
          history: [
            {
              job_id: 'seed001',
              filename: SEEDED,
              status: 'completed',
              start_time: now - 1800,
              end_time: now - 900,
              print_duration: 800,
              total_duration: 900,
            },
          ],
        },
      },
    })
    try {
      const page = journey.ownerPage
      expect(journey.printer.control.historyJobs).toMatchObject([
        { job_id: 'seed001', filename: SEEDED, status: 'completed' },
      ])
      await journey.expectLiveTelemetry()
      // The import is one read of the fixture's history by the Connector.
      await expect
        .poll(
          () => journey.printer.calls()['HTTP GET /server/history/list'] ?? 0,
          { timeout: 60_000 },
        )
        .toBeGreaterThanOrEqual(1)

      await page.goto(journey.origin + '/historico', {
        waitUntil: 'domcontentloaded',
      })
      await expect(
        page.getByRole('heading', { name: 'Histórico de trabalhos' }),
      ).toBeVisible()
      const entry = page
        .getByRole('table', { name: 'Trabalhos finalizados' })
        .getByRole('row')
        .filter({ hasText: SEEDED })
        .filter({ hasText: 'Concluído' })
      await expect(async () => {
        await page.getByRole('button', { name: 'Atualizar histórico' }).click()
        await expect(entry).toHaveCount(1, { timeout: 3000 })
      }).toPass({ timeout: 90_000 })
      await expect(
        entry.getByRole('cell', { name: journey.printerKey, exact: true }),
      ).toBeVisible()
      // Read-only import: it wrote nothing to the printer.
      expect(journey.printer.control.gcodeScripts).toEqual([])
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })
    } catch (error) {
      console.error(
        JSON.stringify(journey.simulatorObservation()),
        journey.appLog(),
      )
      throw error
    } finally {
      await journey.close()
    }
  })
