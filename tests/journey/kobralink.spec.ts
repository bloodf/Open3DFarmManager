import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'
import type { KobraBridgeSimulator } from './harness-kobralink-bridge.ts'

// Legacy path: new Kobra X setup is native (kobra-x-native.spec.ts); this journey
// keeps the explicit KobraLink bridge and its existing assignments covered.
// Opt-in: OPENFARM_JOURNEY=1. One KobraLink printer walks the whole journey in
// the browser against the loopback bridge stand-in: found by the Connector's
// probe, set up on the printers page, live telemetry, every command the
// Connector advertises, a file uploaded and started, the job end card and the
// history entry. Nothing here reaches a physical printer.
const PRINTER_KEY = 'journey-kobralink'
const UPLOAD = 'journey-part.gcode'
const GCODE = '; synthetic journey file\nG28\nG1 X10 Y10 F3000\n'

if (journeyEnabled())
  test.describe('KobraLink journey (legacy bridge, explicit opt-in)', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined
    let found: unknown

    const journey = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    const bridge = () => journey().vendor?.raw as KobraBridgeSimulator
    const commandPaths = () => bridge().commands.map((command) => command.path)
    const row = (page: Page = journey().ownerPage) =>
      page.getByRole('article').filter({
        has: page.getByRole('heading', { name: PRINTER_KEY, exact: true }),
      })
    const stateOf = (page?: Page) =>
      row(page)
        .locator('dt', { hasText: 'Último estado informado' })
        .locator('xpath=following-sibling::dd[1]')

    /**
     * Each signed command uses one control session; the Connector re-opens its
     * control inbox a few seconds after the previous one settles.
     */
    const inboxReady = () =>
      expect
        .poll(() => journey().simulatorObservation().pauseInboxReady, {
          timeout: 60_000,
        })
        .toBe(true)

    /**
     * Clicks a control, confirms its dialog and returns the settled outcome.
     * A control session can end before anything is sent (the dialog then says
     * so); like the operator, try again, but only while the bridge has
     * recorded no new command, so nothing is ever sent twice.
     */
    async function confirm(trigger: Locator, title: string) {
      const page = journey().ownerPage
      const sent = bridge().commands.length
      const dialog = page.getByRole('dialog')
      const send = dialog
        .locator('button:enabled')
        .filter({ hasText: /^\s*Confirmar/ })
      const close = dialog.getByRole('button', { name: 'Fechar' })
      const unsent: string[] = []
      for (let attempt = 0; attempt < 8; attempt++) {
        await inboxReady()
        await expect(trigger).toBeEnabled({ timeout: 45_000 })
        await expect(trigger).not.toHaveAttribute('aria-disabled', 'true', {
          timeout: 45_000,
        })
        await trigger.click()
        await expect(dialog.getByRole('heading')).toContainText(title)
        await expect(send.or(close)).toBeVisible({ timeout: 45_000 })
        if (!(await close.isVisible())) {
          // The capability window can lapse between the check and the click.
          await send.click({ timeout: 5000 }).catch(() => {})
          await expect(close).toBeVisible({ timeout: 45_000 })
        }
        const outcome = await dialog.getByRole('status').innerText()
        await close.click()
        await expect(dialog).toBeHidden()
        if (bridge().commands.length > sent) return outcome
        unsent.push(outcome)
      }
      throw new Error('Command never reached the bridge: ' + unsent.join(' | '))
    }

    /**
     * Runs one files-page operation until it has its effect. Same rule as
     * `confirm`: repeat only while the operation demonstrably did nothing.
     */
    async function filesStep(
      button: Locator,
      before: () => Promise<void>,
      done: () => boolean | Promise<boolean>,
    ) {
      const status = journey().ownerPage.getByRole('status').last()
      const seen: string[] = []
      for (let attempt = 0; attempt < 8; attempt++) {
        await inboxReady()
        // The page clears its form whenever the live view changes, so the
        // inputs are filled only once the printer is available.
        await expect(
          journey().ownerPage.locator('#files-unavailable'),
        ).toBeHidden({ timeout: 60_000 })
        await before()
        if (
          !(await button
            .click({ timeout: 10_000 })
            .then(() => true)
            .catch(() => false))
        ) {
          seen.push('not available')
          continue
        }
        await expect(
          journey().ownerPage.getByRole('button', {
            name: 'Cancelar operação',
          }),
        ).toBeHidden({ timeout: 90_000 })
        await expect(status).not.toHaveText('', { timeout: 15_000 })
        const text = await status.innerText()
        if (await done()) return text
        seen.push(text)
      }
      throw new Error('Files operation had no effect: ' + seen.join(' | '))
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(20 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'kobralink',
        printerKey: PRINTER_KEY,
        signedControl: true,
        history: true,
        // Find the bridge with the Connector's own probe, then set the
        // printer up in the browser on the printers page.
        async setup({ page, origin, farmId, agentId, printerKey, vendor }) {
          found = await vendor?.discovery?.probe()
          await page.goto(origin + '/impressoras', {
            waitUntil: 'domcontentloaded',
          })
          await page.getByLabel('Farm', { exact: true }).selectOption(farmId)
          const form = page.getByRole('group', {
            name: 'Configuração confirmada localmente',
          })
          await form
            .getByLabel('Connector aprovado', { exact: true })
            .selectOption(agentId)
          await form.getByLabel('Chave exata da impressora').fill(printerKey)
          await form.getByRole('checkbox').check()
          await form
            .getByRole('button', { name: 'Cadastrar atribuição' })
            .click()
          const assignments = page.getByRole('region', { name: 'Atribuições' })
          await expect(
            assignments.getByText(printerKey, { exact: true }),
          ).toBeVisible({ timeout: 15_000 })
          await expect(
            assignments.getByText('Ativa', { exact: true }),
          ).toBeVisible()
        },
      })
    })

    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test.afterEach(async ({}, info) => {
      if (info.status !== info.expectedStatus && harness)
        console.error(
          JSON.stringify(harness.simulatorObservation()),
          JSON.stringify(bridge().commands),
          JSON.stringify(bridge().requests),
          await harness.ownerPage
            .locator('main')
            .innerText({ timeout: 2000 })
            .catch(() => ''),
          await row()
            .innerText({ timeout: 2000 })
            .catch(() => ''),
          harness.appLog(),
        )
    })

    test('the bridge is found by the probe and set up in the browser', async () => {
      expect(found).toMatchObject({
        vendor: 'kobralink',
        host: journey().discovery?.host,
      })
      const port = (found as { port: number }).port
      expect(port).toBeGreaterThanOrEqual(7126)
      expect(port).toBeLessThanOrEqual(journey().discovery?.port ?? 0)
      expect(journey().assignmentId).toMatch(/^[0-9a-f-]{36}$/)
    })

    test('live telemetry reaches the farm page', async () => {
      test.setTimeout(3 * 60_000)
      await journey().expectLiveTelemetry()
      await expect(stateOf()).toHaveText('Imprimindo')
      expect(bridge().observed.signIns).toBeGreaterThan(0)
      journey().controls.setProgress(75)
      await journey().expectProgress(0.75)
      await expect(
        row().getByText('Progresso informado da impressão: 75%'),
      ).toBeVisible()
    })

    test('commands without a bridge route are shown as not supported', async () => {
      const extended = row().getByRole('region', {
        name: 'Controles adicionais de ' + PRINTER_KEY,
      })
      await expect(
        extended.getByRole('heading', {
          name: 'Comandos não suportados por esta impressora',
        }),
      ).toBeVisible({ timeout: 30_000 })
      // The bridge has no route for these: named as unsupported, never offered.
      const unsupported = [
        'Reiniciar firmware',
        'Parada de emergência',
        'Carregar filamento',
        'Descarregar filamento',
      ]
      await expect(extended.locator('dl dt')).toHaveText(unsupported)
      await expect(extended.locator('dl dd')).toHaveText(
        unsupported.map(() => 'Não suportado'),
      )
      for (const name of unsupported)
        await expect(
          extended.getByRole('button', { name, exact: true }),
        ).toHaveCount(0)
    })

    test('every advertised command is confirmed and reaches the bridge', async () => {
      test.setTimeout(10 * 60_000)
      const controls = row().getByRole('group', {
        name: 'Controles da impressora ' + PRINTER_KEY,
      })
      const extended = row().getByRole('region', {
        name: 'Controles adicionais de ' + PRINTER_KEY,
      })
      const lifecycle = (name: string) =>
        controls.getByRole('button', { name, exact: true })
      const action = (name: string) => extended.getByRole('button', { name })
      const unconfirmed =
        'Resultado desconhecido. Verifique a impressora antes de tentar novamente.'

      expect(await confirm(lifecycle('Pausar'), PRINTER_KEY)).toBe(
        'Impressão pausada. O Connector confirmou a pausa.',
      )
      await expect(stateOf()).toHaveText('Pausada', { timeout: 30_000 })
      expect(await confirm(lifecycle('Retomar'), PRINTER_KEY)).toBe(
        'Impressão retomada. O Connector confirmou a retomada.',
      )
      await expect(stateOf()).toHaveText('Imprimindo', { timeout: 30_000 })

      await extended.getByLabel('Aquecedor').selectOption('extruder')
      await extended.getByLabel('Temperatura em °C').fill('215')
      expect(
        await confirm(action('Definir temperatura'), 'Definir temperatura'),
      ).toBe(unconfirmed)
      await extended.getByLabel('Ventilador').selectOption('part')
      await extended.getByLabel('Velocidade em %').fill('80')
      expect(
        await confirm(action('Definir ventilador'), 'Definir ventilador'),
      ).toBe(unconfirmed)
      await extended.getByLabel('Luz').selectOption('off')
      expect(await confirm(action('Definir luz'), 'Definir luz')).toBe(
        unconfirmed,
      )
      // "Velocidade" also starts the fan's "Velocidade em %" label.
      await extended
        .locator('select')
        .filter({ has: journey().ownerPage.locator('option[value="sport"]') })
        .selectOption('sport')
      expect(
        await confirm(action('Definir velocidade'), 'Definir velocidade'),
      ).toBe(unconfirmed)

      expect(await confirm(lifecycle('Cancelar'), PRINTER_KEY)).toBe(
        'Impressão cancelada. O Connector confirmou o cancelamento.',
      )
      await expect(stateOf()).toHaveText('Ociosa', { timeout: 30_000 })
      // The cancelled job has its own end card.
      await expect(row().getByText('Cancelado', { exact: true })).toBeVisible()
      await expect(
        row()
          .locator('dl[aria-label="Último trabalho"]')
          .getByText('journey.gcode', { exact: true }),
      ).toBeVisible()

      // Homing needs an idle printer.
      expect(
        await confirm(action('Referenciar eixos'), 'Referenciar eixos'),
      ).toBe(unconfirmed)

      // Exactly one bridge write per command, in order, with the mapped body.
      expect(bridge().commands).toEqual([
        { path: 'print/pause', body: undefined },
        { path: 'print/resume', body: undefined },
        { path: 'temperature', body: { nozzle: 215 } },
        { path: 'fan', body: { speed: 80 } },
        { path: 'light', body: { on: false } },
        { path: 'speed', body: { mode: 3 } },
        { path: 'print/cancel', body: undefined },
        { path: 'axis', body: { axis: 4, moveType: 2, distance: 0 } },
      ])
    })

    test('a file is uploaded and started from the files page', async () => {
      test.setTimeout(10 * 60_000)
      const page = journey().ownerPage
      await page.goto(journey().origin + '/arquivos', {
        waitUntil: 'domcontentloaded',
      })
      await page
        .getByLabel('Impressora', { exact: true })
        .selectOption({ label: PRINTER_KEY })
      expect(
        await filesStep(
          page.getByRole('button', { name: 'Enviar arquivo' }),
          () =>
            page.getByLabel(/^Arquivo \.gcode/).setInputFiles({
              name: UPLOAD,
              mimeType: 'text/plain',
              buffer: Buffer.from(GCODE),
            }),
          () => bridge().library.length > 0,
        ),
      ).toBe(
        'Arquivo enviado à biblioteca da ponte. Atualize a lista para selecionar e iniciar a impressão.',
      )
      // The bridge received the exact bytes once, as a library file only.
      expect(bridge().library).toEqual([
        {
          id: 'journey-file-1',
          filename: UPLOAD,
          sizeBytes: Buffer.byteLength(GCODE),
          content: GCODE,
        },
      ])
      expect(commandPaths()).not.toContain('print')

      const existing = page.getByLabel('Arquivo para imprimir')
      expect(
        await filesStep(
          page.getByRole('button', { name: 'Consultar arquivos' }),
          async () => {},
          () => existing.isVisible(),
        ),
      ).toBe('Arquivos atualizados.')
      const option = existing.locator('option', { hasText: UPLOAD })
      await expect(option).toHaveCount(1)

      const starts = () =>
        bridge().commands.filter((command) => command.path === 'print')
      expect(
        await filesStep(
          page.getByRole('button', { name: 'Iniciar impressão' }),
          async () => {
            await existing.selectOption(UPLOAD)
            await page.getByRole('checkbox').check()
          },
          () => starts().length > 0,
        ),
      ).toBe(
        'Resultado desconhecido. Verifique a impressora antes de tentar novamente.',
      )
      expect(starts()).toEqual([
        {
          path: 'print',
          body: { fileId: 'journey-file-1', excludedObjects: [] },
        },
      ])
      expect(bridge().state).toMatchObject({
        printState: 'printing',
        filename: UPLOAD,
      })
    })

    test('the finished job shows its end card and history entry', async () => {
      test.setTimeout(5 * 60_000)
      const page = journey().ownerPage
      await journey().openFarm()
      await expect(stateOf()).toHaveText('Imprimindo', { timeout: 45_000 })
      journey().controls.setProgress(60)
      await journey().expectProgress(0.6)
      journey().controls.finishPrint()

      await expect(stateOf()).toHaveText('Ociosa', { timeout: 30_000 })
      await expect(row().getByText('Concluído', { exact: true })).toBeVisible()
      const card = row().locator('dl[aria-label="Último trabalho"]')
      await expect(card.getByText(UPLOAD, { exact: true })).toBeVisible()
      await expect(card.getByText('0 h 30 min', { exact: true })).toBeVisible()
      // The bridge keeps refreshing its timestamp; the end time must not move.
      const ended = card
        .locator('dt', { hasText: 'Fim' })
        .locator('xpath=following-sibling::dd[1]')
      const endedAt = await ended.innerText()
      await page.waitForTimeout(3000)
      await expect(ended).toHaveText(endedAt)
      await expect(row().getByRole('progressbar')).toHaveCount(0)

      await page.goto(journey().origin + '/historico', {
        waitUntil: 'domcontentloaded',
      })
      const table = page.getByRole('table', { name: 'Trabalhos finalizados' })
      const rows = table.locator('tbody tr')
      // Telemetry reaches the server a moment after the live view.
      await expect(async () => {
        await page.getByRole('button', { name: 'Atualizar histórico' }).click()
        await expect(rows.filter({ hasText: 'Concluído' })).toHaveCount(1, {
          timeout: 3000,
        })
      }).toPass({ timeout: 60_000 })
      // Newest first: the print started from the files page, then the one
      // cancelled earlier. Each end is recorded once.
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0).locator('td')).toHaveText([
        PRINTER_KEY,
        'Concluído',
        UPLOAD,
        /^\d{2}\/\d{2}\/\d{4}/,
        '0 h 30 min',
      ])
      await expect(rows.nth(1).locator('td')).toHaveText([
        PRINTER_KEY,
        'Cancelado',
        'journey.gcode',
        /^\d{2}\/\d{2}\/\d{4}/,
        'Não informada',
      ])
      await page.getByLabel('Impressora (opcional)').fill('another-printer')
      await page.getByRole('button', { name: 'Atualizar histórico' }).click()
      await expect(
        page.getByText('Nenhum trabalho finalizado registrado.'),
      ).toBeVisible()
      expect(journey().simulatorObservation()).toMatchObject({ failure: false })
    })
  })
