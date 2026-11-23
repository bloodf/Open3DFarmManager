import { expect, type Locator } from '@playwright/test'
import {
  reportedPrintProgressBar,
  reportedProgressValue,
  type JourneyHarness,
} from './harness.ts'

export function floorTile(journey: JourneyHarness): Locator {
  return journey.ownerPage.getByRole('listitem').filter({
    has: journey.ownerPage.getByRole('button', {
      name: new RegExp(`^Inspecionar ${journey.printerKey} `),
    }),
  })
}

export async function openLiveInspector(journey: JourneyHarness) {
  await journey.openFarm()
  const tile = floorTile(journey)
  await tile.getByRole('button', { name: /^Inspecionar / }).click()
  const inspector = journey.ownerPage.getByRole('dialog', {
    name: 'Inspeção da impressora',
  })
  const printer = inspector.getByRole('article')
  await expect(
    printer.getByText('Conexão direta autenticada', { exact: true }),
  ).toBeVisible({ timeout: 60_000 })
  await expect(reportedPrintProgressBar(printer)).toHaveAttribute(
    'aria-valuenow',
    reportedProgressValue(0.25),
  )
  return printer
}
