import { expect, test } from '@playwright/test'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. A new Kobra X is set up in the browser through
// the native backend on the loopback Kobra X mock: IPv4, the operator's client
// certificate, the Connector's own login on the mock as connection test, the
// signed review and the confirmed assignment. No KobraLink bridge, no Docker
// printer container and no KOBRALINK_SRC. Never a physical printer.
// Written for #369; the browser run belongs to the offline acceptance in #367.
if (journeyEnabled())
  test.describe('Kobra X native setup journey', () => {
    test.describe.configure({ mode: 'serial' })
    let harness: JourneyHarness | undefined
    const started = () => {
      if (!harness) throw new Error('Harness did not start')
      return harness
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(5 * 60_000)
      harness = await startJourneyHarness({ browser, kobraX: true })
    })
    test.afterAll(async () => {
      test.setTimeout(2 * 60_000)
      await harness?.close()
      harness = undefined
    })

    test('sets up a Kobra X natively by default and confirms it with the Connector', async () => {
      test.setTimeout(5 * 60_000)
      const journey = started()
      const { mock, lanAddress } = journey.kobraX ?? {}
      const configurator = journey.configurator
      if (!mock || !lanAddress || !configurator)
        throw new Error('Native Kobra X setup needs the mock and its Connector')
      const page = journey.ownerPage
      await page.goto(journey.origin + '/impressoras', {
        waitUntil: 'domcontentloaded',
      })
      await page
        .getByLabel('Farm', { exact: true })
        .selectOption(journey.farmId)
      await page.locator('#kobra-connector').selectOption(configurator.agentId)
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

      await page.locator('#onboarding-family').selectOption('anycubic-kobra-x')
      // Native is the default; the bridge is an explicit legacy choice.
      await expect(page.locator('#kobra-mode-native')).toBeChecked()
      await expect(page.locator('#kobra-mode-bridge')).not.toBeChecked()
      await page.locator('#kobra-ip').fill(lanAddress)
      await page.locator('#kobra-cert-file').setInputFiles({
        name: 'anycubic-slicer-next.pem',
        mimeType: 'application/x-pem-file',
        buffer: Buffer.concat([mock.tls.clientCert, mock.tls.clientKey]),
      })
      // Other setup summaries also render a <dl>; target the certificate one.
      const certificate = page
        .locator('dl')
        .filter({ has: page.getByText('Formato validado', { exact: true }) })
      await expect(certificate).toContainText('AnycubicSlicer')
      await page
        .getByRole('button', { name: 'Preparar Anycubic Kobra X' })
        .click()

      // Reached only after the Connector logged in to the mock over mutual TLS.
      await expect(page.locator('#kobra-prepared-heading')).toBeVisible({
        timeout: 60_000,
      })
      const review = page.locator(
        'section[aria-labelledby="kobra-prepared-heading"]',
      )
      await expect(review).toContainText('Suporte não qualificado')
      await expect(review).not.toContainText(/ponte/i)
      await page.locator('#kobra-confirm-checkbox').check()
      await page
        .getByRole('button', { name: 'Confirmar e ativar impressora' })
        .click()

      await expect(
        page.getByText(
          'Impressora adicionada e confirmada com recibo assinado pelo Connector.',
        ),
      ).toBeVisible({ timeout: 90_000 })
      const assignments = page.getByRole('region', { name: 'Atribuições' })
      await expect(
        assignments.getByText(/^kobra-x-[A-Za-z0-9_-]{43}$/),
      ).toBeVisible()
      // Secrets stay out of the page and of browser storage.
      const text = await page.evaluate(
        () => document.body.innerText + JSON.stringify(sessionStorage),
      )
      expect(text).not.toContain(mock.credentials.password)
      expect(text).not.toContain(mock.credentials.token)
      expect(text).not.toContain('PRIVATE KEY')
    })
  })
