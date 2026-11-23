// Creality journey selectors for the current farm page: a printer's detail
// and controls live in the "Inspeção da impressora" dialog, which the wall
// card opens, and command confirmations open a second dialog on top of it.
// These helpers only scope selectors; they assert nothing about the printer.
import { expect, type Locator, type Page } from '@playwright/test'
import {
  reportedProgress,
  reportedProgressValue,
  type JourneyHarness,
} from './harness.ts'

/** Opens the farm page and the printer's inspector; returns its article. */
export async function inspectPrinter(
  journey: JourneyHarness,
  page: Page = journey.ownerPage,
): Promise<Locator> {
  await journey.openFarm(page)
  const wall = page
    .getByRole('button', { name: /^Inspecionar / })
    .filter({ has: page.getByText(journey.printerKey, { exact: true }) })
  await expect(wall).toBeVisible({ timeout: 30_000 })
  await wall.click()
  await expect(
    page.getByRole('dialog', { name: 'Inspeção da impressora', exact: true }),
  ).toBeVisible()
  return journey.farmRow(page)
}

/**
 * The command confirmation dialog of this printer, never the inspector under
 * it: its title names the printer ("Pausar impressão de <printer>").
 */
export function commandDialog(journey: JourneyHarness, page: Page): Locator {
  return page.getByRole('dialog', {
    name: new RegExp(journey.printerKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  })
}

/**
 * The inspected printer shows an authenticated direct connection and the
 * simulator's initial 25 % progress (the harness's own live check, run on the
 * open inspector instead of the wall).
 */
export async function expectInspectedTelemetry(
  journey: JourneyHarness,
  page: Page = journey.ownerPage,
) {
  const row = await inspectPrinter(journey, page)
  await expect(
    row.getByText('Conexão direta autenticada', { exact: true }),
  ).toBeVisible({ timeout: 60_000 })
  await expect(reportedProgress(row)).toHaveAttribute(
    'aria-valuenow',
    reportedProgressValue(0.25),
  )
  return row
}
