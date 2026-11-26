import { expect, test, type Locator } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import { recordJourneyDiagnostics } from './journey-diagnostics.ts'
import { qidiVariant } from '../fixtures/qidi/variants.ts'
import type { startStatusFixture, StatusVendor } from './status-fixtures.ts'

const ROW_CONTROLS = /pausar|retomar|cancelar|iniciar impressão/i
const SURFACE_CONTROLS = /pausar|retomar|cancelar impressão|iniciar impressão/i

async function noControls(surface: Locator, name: RegExp) {
  await expect
    .soft(surface.getByRole('button', { name }))
    .toHaveCount(0, { timeout: 2000 })
}

export function statusJourney(name: StatusVendor) {
  if (journeyEnabled())
    test(`${name}: status is withdrawn and recovers read-only`, async ({
      browser,
    }, testInfo) => {
      const journey = await startJourneyHarness({ browser, simulator: name })
      const page = journey.ownerPage
      const diagnostics = recordJourneyDiagnostics()
      diagnostics.watch('owner', page)
      page.context().on('page', (other) => diagnostics.watch('other', other))
      const attach = async () => {
        try {
          await diagnostics.attach(testInfo)
        } catch {
          // Diagnostic failure must not mask the journey failure.
        }
      }
      try {
        const fixture = journey.vendor?.raw as Awaited<
          ReturnType<typeof startStatusFixture>
        >
        // The Connector serves one read-only browser link at a time; a second
        // live tab competes for it and can starve the farm row. The farm row,
        // inspector and detail page are therefore visited in turn on one page,
        // and each is checked while it holds the direct connection.
        let detailHref = ''
        const openFarmSurfaces = async (back = false) => {
          const row = back
            ? (await page.goBack(), journey.farmRow(page))
            : await journey.openFarm(page)
          await page
            .getByRole('button', {
              name: new RegExp(`^Inspecionar journey-${name}\\b`),
            })
            .click()
          const inspector = page.getByRole('dialog', {
            name: 'Inspeção da impressora',
          })
          await expect(inspector).toBeVisible()
          detailHref = new URL(
            (await inspector
              .getByRole('link', { name: 'Abrir detalhes da impressora' })
              .getAttribute('href')) ?? '',
            page.url(),
          ).href
          return { row, inspector }
        }
        const farmReadOnly = async (row: Locator, inspector: Locator) => {
          await noControls(row, ROW_CONTROLS)
          await noControls(inspector, SURFACE_CONTROLS)
        }
        const detailReadOnly = async (live?: string) => {
          await page.goto(detailHref)
          const main = page.getByRole('main')
          await expect(main.getByText(`journey-${name}`).first()).toBeVisible()
          if (live) {
            await expect(
              main.getByText('Connector: conexão direta ativa', {
                exact: true,
              }),
            ).toBeVisible({ timeout: 90_000 })
            await expect(main).toContainText(live, { timeout: 30_000 })
          }
          await noControls(main, SURFACE_CONTROLS)
        }

        let { row, inspector } = await openFarmSurfaces()
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect(row).toContainText('Imprimindo', { timeout: 30_000 })
        await farmReadOnly(row, inspector)
        await detailReadOnly('Imprimindo')

        ;({ row, inspector } = await openFarmSurfaces())
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        const count = fixture.requests.length
        fixture.loseConnection()
        await expect
          .poll(() => fixture.requests.length, { timeout: 30_000 })
          .toBeGreaterThan(count)
        await expect(
          row.getByText(
            'Conexão direta indisponível. Exibindo a última observação.',
            { exact: true },
          ),
        ).toBeVisible({ timeout: 90_000 })
        await expect(
          row.getByText(/Dados desatualizados/).first(),
        ).toBeVisible()
        await farmReadOnly(row, inspector)
        fixture.recover()
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect(row).toContainText('Ociosa', { timeout: 30_000 })
        await farmReadOnly(row, inspector)
        await detailReadOnly('Ociosa')
        fixture.loseConnection()
        const main = page.getByRole('main')
        await expect(
          main
            .getByText(/Sem conexão direta: exibindo o último valor conhecido/)
            .first(),
        ).toBeVisible({ timeout: 90_000 })
        await noControls(main, SURFACE_CONTROLS)
        fixture.recover()
        await expect(
          main.getByText('Connector: conexão direta ativa', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect(main).toContainText('Ociosa', { timeout: 30_000 })

        if (name === 'qidi') {
          expect(new Set<string | number>([...fixture.requests])).toEqual(
            new Set(['GET /server/info', `GET ${qidiVariant('Q1 Pro').query}`]),
          )
        } else if (name === 'flashforge') {
          expect(new Set<string | number>([...fixture.requests])).toEqual(
            new Set(['POST /detail']),
          )
        } else if (name === 'halot') {
          expect(new Set<string | number>([...fixture.requests])).toEqual(
            new Set(['VERSION_CHECK', 'GET_PRINT_STATUS']),
          )
        } else {
          expect(new Set<string | number>([...fixture.requests])).toEqual(
            new Set([0]),
          )
        }
        if (testInfo.errors.length) await attach()
      } catch (error) {
        await attach()
        throw error
      } finally {
        await journey.close()
      }
    })
}
