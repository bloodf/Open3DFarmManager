// SPDX-License-Identifier: MIT
import { join } from 'node:path'
import { expect as pw } from '@playwright/test'
import { afterAll, beforeAll, it, vi } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

vi.setConfig({ testTimeout: 30_000 })

const farmId = '00000000-0000-4000-8000-000000000001'
const library = `/api/farms/${farmId}/spool-library`
const spool = {
  id: 42,
  filament: {
    id: 3,
    name: 'PLA Azul',
    material: 'PLA',
    color_hex: '0055FF',
    density: 1.24,
    diameter: 1.75,
    weight: 1000,
    extra: {},
  },
  remaining_weight: 120,
  used_weight: 0,
  used_length: 0,
  location: 'Armário Azul',
  archived: false,
  extra: {},
}

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness({
    replace: {
      [join(process.cwd(), 'apps/farm/app/composables/useFarmView.ts')]: join(
        process.cwd(),
        'tests/helpers/farm-scope-view-stub.ts',
      ),
    },
  })
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

it('updates spool search and reloads once when the route query changes', async () => {
  const requestedQueries: (string | null)[] = []
  const routes: Routes = {
    'GET /api/auth/me': reply({ accountId: 'account-one' }),
    'GET /api/farms': reply({ farms: [{ farmId }] }),
    'GET /api/browser-devices': reply({
      currentAccountId: 'account-one',
      currentRole: 'owner',
      devices: [],
      nextAfter: null,
    }),
    [`GET ${library}/spools`]: ({ url }) => {
      requestedQueries.push(url.searchParams.get('q'))
      return reply({
        items: [spool],
        total: 1,
        canWrite: true,
        canImport: true,
      })
    },
    [`GET ${library}/filaments`]: reply({ items: [] }),
    [`GET ${library}/vendors`]: reply({ items: [] }),
    [`GET ${library}/slots`]: reply({ assignments: [] }),
  }
  const opened = await harness.open('bobinas/index', routes, {
    route: { query: { farm: farmId, q: 'Lote-314' } },
  })
  try {
    const { page } = opened
    const search = page.getByRole('searchbox', { name: 'Buscar' })
    await pw(search).toHaveValue('Lote-314')
    await pw.poll(() => requestedQueries).toContain('Lote-314')

    await page.evaluate(() => {
      const target = window as unknown as {
        __pageRoute: { query: { farm?: string; q?: string } }
      }
      target.__pageRoute.query.q = '#42'
    })
    await pw(search).toHaveValue('#42')
    await pw
      .poll(() => requestedQueries.filter((q) => q === '#42'))
      .toEqual(['#42'])
  } finally {
    await opened.close()
  }
})

it('keeps a padded Spoolman UUID intact until blur trims and validates it', async () => {
  const opened = await harness.open(
    'spoolman',
    {
      'GET /api/farms': reply({ farms: [{ farmId }] }),
      'GET /api/auth/me': reply({ accountId: 'account-one' }),
      'GET /api/browser-devices': reply({
        currentAccountId: 'account-one',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
      }),
      [`GET /api/farms/${farmId}/spoolman`]: reply({
        settings: [],
        canManage: true,
      }),
      [`GET /api/farms/${farmId}/connectors`]: reply({
        connectors: [
          {
            agentId: '00000000-0000-4000-8000-000000000002',
            status: 'approved',
          },
        ],
      }),
    },
    { route: { query: { farm: farmId } } },
  )
  try {
    const uuid = '00000000-0000-4000-8000-0000000000b1'
    const padded = '  ' + uuid + '  '
    const field = opened.page.getByLabel('UUID do serviço (opcional)')
    await field.pressSequentially(padded)
    await pw(field).toHaveValue(padded)
    await field.blur()
    await pw(field).toHaveValue(uuid)
    await pw(field).not.toHaveAttribute('aria-invalid', 'true')
  } finally {
    await opened.close()
  }
})
