import { expect, test, type Page } from '@playwright/test'
import type { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import {
  commandDialog,
  expectInspectedTelemetry,
  inspectPrinter,
} from './creality-inspector.ts'
import { discoverOnPage } from './discovery-page.ts'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. A Creality printer that advertises a secure
// endpoint: the Connector's probe reads the HTTPS /info of the simulator
// (verified against the synthetic CA of its binding), takes the advertised
// WSS port, and every browser command and file listing then reaches the
// printer over that WSS socket. The simulator's plain WebSocket listener stays
// up as the plaintext target: it must not receive a single upgrade, and the
// plain /info responder must not be asked. The plain (stock firmware) path is
// covered, unchanged, by creality.spec.ts.
// Without the opt-in no test is registered, so nothing starts by accident.

type CrealitySim = Awaited<ReturnType<typeof createCrealitySimulator>>

const NOT_SENT = /Nenhum comando foi enviado\./
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

if (journeyEnabled())
  test.describe('journey: Creality secure endpoint', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined

    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }
    const simulator = () => started().vendor?.raw as CrealitySim
    /** Upgrades the plain (non-TLS) WebSocket listener has accepted. */
    const plainUpgrades = () =>
      (simulator().calls() as Record<string, number>).UPGRADE ?? 0
    /** Commands and file listings the simulator received, whichever socket. */
    const gets = () =>
      simulator()
        .requests.filter((request) => request.method === 'get')
        .map((request) => request.params)

    const printerRow = (page: Page) =>
      page.getByRole('article').filter({
        has: page.getByRole('heading', {
          name: started().printerKey,
          exact: true,
        }),
      })
    const reportedState = (page: Page, label: string) =>
      expect(
        printerRow(page)
          .locator('dt', { hasText: 'Último estado informado' })
          .locator('+ dd'),
      ).toHaveText(label, { timeout: 20_000 })

    /** Each signed operation consumes one control session of the Connector. */
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
     * One lifecycle command from the printer row, signed in the browser. A
     * session that ended before anything was sent is repeated, as the
     * operator would.
     */
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
      const dialog = commandDialog(started(), page)
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
        await expect(control).toHaveAttribute('aria-disabled', 'false', {
          timeout: 20_000,
        })
        await control.click()
        await expect(dialog).toBeVisible()
        await expect(async () => {
          expect(
            (await confirmation.isEnabled()) ||
              NOT_SENT.test((await status.textContent()) ?? ''),
          ).toBe(true)
        }).toPass({ timeout: 45_000 })
        if (await confirmation.isEnabled()) break
        expect(attempt, (await status.textContent()) ?? '').toBeLessThan(4)
        await close()
      }
      await confirmation.click()
      await expect(status).toHaveText(outcome, { timeout: 45_000 })
      await close()
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(20 * 60_000)
      harness = await startJourneyHarness({
        browser,
        simulator: 'creality',
        signedControl: true,
        discovery: true,
        secure: true,
        // Telemetry upload stays open, as a Connector in service does: the
        // issuer grants only controls advertised in the last two minutes.
        history: true,
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
          JSON.stringify({
            secureConnections: simulator().secureConnections,
            plainUpgrades: plainUpgrades(),
          }),
          harness.appLog(),
          await harness.ownerPage
            .locator('main')
            .innerText()
            .then((text) => text.slice(-4000))
            .catch(() => ''),
        )
    })

    test('discovery uses the advertised secure endpoint and the farm lists the printer', async () => {
      test.setTimeout(8 * 60_000)
      const journey = started()
      const discovery = journey.discovery
      if (!discovery?.secure) throw new Error('Secure discovery not started')
      // The page finds the printer through the configuration Connector's
      // probe, which is pointed at the simulator's HTTPS /info.
      await discoverOnPage(journey, {
        family: 'creality-native',
        label: 'Creality K1',
        hostField: 'creality-host',
      })
      // The probe took the WSS port the printer advertised, not a default.
      expect(await discovery.probe()).toMatchObject({
        vendor: 'creality',
        host: '127.0.0.1',
        port: simulator().securePort,
        transport: 'wss',
      })
      // The plain /info responder was never asked: no downgrade, no fallback.
      expect(discovery.plainRequests?.()).toBe(0)
      const row = await inspectPrinter(journey)
      await expect(row).toContainText('Atribuição ativa. Connector aprovado.')
    })

    test('live telemetry arrives over WSS and nothing reaches the plain listener', async () => {
      test.setTimeout(2 * 60_000)
      const journey = started()
      await expectInspectedTelemetry(journey)
      await reportedState(journey.ownerPage, 'Imprimindo')
      // The Connector connected to the secure listener, verified by its CA.
      expect(simulator().secureConnections).toBeGreaterThan(0)
      expect(plainUpgrades()).toBe(0)
    })

    test('pause and resume reach the printer over WSS', async () => {
      test.setTimeout(3 * 60_000)
      const page = started().ownerPage
      await lifecycle(
        page,
        'Pausar',
        'Confirmar pausa',
        'Impressão pausada. O Connector confirmou a pausa.',
      )
      expect(simulator().state.state).toBe(2)
      await reportedState(page, 'Pausada')
      await lifecycle(
        page,
        'Retomar',
        'Confirmar retomada',
        'Impressão retomada. O Connector confirmou a retomada.',
      )
      expect(simulator().state.state).toBe(1)
      await reportedState(page, 'Imprimindo')
      expect(simulator().secureConnections).toBeGreaterThan(0)
      expect(plainUpgrades()).toBe(0)
    })

    test('the file list is read over WSS and nothing reaches the plain listener', async () => {
      test.setTimeout(4 * 60_000)
      const journey = started()
      const page = journey.ownerPage
      // File operations need an idle printer: the simulated print ends first.
      if ([1, 2].includes(simulator().state.state as number)) {
        journey.controls.finishPrint()
        await inspectPrinter(journey)
        await reportedState(page, 'Ociosa')
      }
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
      const listed = 'Nenhum arquivo nesta impressora.'
      // A session that failed or was cancelled before the work was done is
      // repeated by the operator, and so is it here.
      const undone = [
        'Não foi possível concluir pela conexão direta. Verifique a impressora antes de tentar novamente.',
        'Operação cancelada neste navegador. Confira o estado da impressora e seus arquivos antes de tentar novamente.',
      ]
      for (let attempt = 1; ; attempt++) {
        await controlInbox()
        await expect(input).toBeEnabled({ timeout: 45_000 })
        await page
          .getByRole('button', { name: 'Consultar arquivos', exact: true })
          .click()
        await expect(status).toHaveText(
          new RegExp(`^(${[listed, ...undone].map(escape).join('|')})$`),
          { timeout: 60_000 },
        )
        const text = (await status.textContent()) ?? ''
        if (text === listed) break
        expect(attempt, text).toBeLessThan(5)
      }
      expect(gets()).toContainEqual({ reqGcodeFile: 1 })
      // Nothing was uploaded, and the plaintext listener saw no peer at all.
      expect(simulator().uploads.size).toBe(0)
      expect(plainUpgrades()).toBe(0)
      expect(simulator().secureConnections).toBeGreaterThan(0)
      expect(journey.simulatorObservation()).toMatchObject({ failure: false })
    })
  })
