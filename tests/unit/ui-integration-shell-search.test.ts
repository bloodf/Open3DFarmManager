// SPDX-License-Identifier: MIT
import { expect as pw, type Page } from '@playwright/test'
import { afterAll, beforeAll, it, vi } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

vi.setConfig({ testTimeout: 30_000 })

const farmId = '00000000-0000-4000-8000-000000000001'
const spool = {
  id: 42,
  archived: false,
  lot_nr: 'Lote-314',
  location: 'Armário Azul',
  filament: {
    id: 3,
    name: 'PLA Azul',
    material: 'PLA',
    color_hex: '0055FF',
    density: 1.24,
    diameter: 1.75,
    extra: {},
  },
  registered: '2026-01-01',
  used_weight: 0,
  used_length: 0,
  extra: {},
}

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

function shellRoutes(queries: string[]): Routes {
  return {
    'GET /api/auth/me': reply({ accountId: 'conta-teste' }),
    'GET /api/farms': reply({ farms: [{ farmId }] }),
    'GET /api/browser-devices': reply({ currentRole: 'owner' }),
    [`GET /api/farms/${farmId}/spool-library/spools`]: ({ url }) => {
      const query = url.searchParams.get('q') ?? ''
      if (query) queries.push(query)
      return reply({ items: query ? [spool] : [], total: query ? 1 : 0 })
    },
  }
}

async function openPalette(page: Page) {
  await page.getByRole('button', { name: /Buscar/ }).click()
  return page.getByRole('combobox', {
    name: 'Buscar páginas, impressoras e bobinas',
  })
}

it.each(['Lote-314', 'Armário Azul', '#42'])(
  'keeps the server spool match for %s',
  async (query) => {
    const queries: string[] = []
    const opened = await harness.open('farm', shellRoutes(queries), {
      layout: true,
      route: { path: '/farm', query: { farm: farmId } },
    })
    try {
      const input = await openPalette(opened.page)
      await input.fill(query)
      await pw.poll(() => queries).toEqual([query])
      await pw(
        opened.page.getByRole('option', { name: 'PLA Azul · #42' }),
      ).toBeVisible()
    } finally {
      await opened.close()
    }
  },
)

it('scrolls the newly active keyboard option into the dialog viewport', async () => {
  const opened = await harness.open('farm', shellRoutes([]), {
    layout: true,
    route: { path: '/farm', query: { farm: farmId } },
    width: 390,
  })
  try {
    const { page } = opened
    await page.evaluate(() => {
      const target = window as unknown as {
        __scrollIntoViewCalls: { id: string; block?: string }[]
      }
      target.__scrollIntoViewCalls = []
      Element.prototype.scrollIntoView = function (options) {
        const block = typeof options === 'object' ? options.block : undefined
        target.__scrollIntoViewCalls.push({
          id: (this as HTMLElement).id,
          ...(block ? { block } : {}),
        })
      }
    })
    const input = await openPalette(page)
    await input.fill('a')
    await pw(page.getByRole('option', { name: 'PLA Azul · #42' })).toBeVisible()
    await pw.poll(() => page.getByRole('option').count()).toBeGreaterThan(1)
    const previousActiveId = await input.getAttribute('aria-activedescendant')
    await input.press('ArrowUp')
    await pw
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { __scrollIntoViewCalls: unknown[] })
              .__scrollIntoViewCalls.length,
        ),
      )
      .toBeGreaterThan(0)
    const activeId = await input.getAttribute('aria-activedescendant')
    pw(activeId).not.toBe(previousActiveId)
    const scrollCall = await page.evaluate(() =>
      (
        window as unknown as {
          __scrollIntoViewCalls: { id: string; block?: string }[]
        }
      ).__scrollIntoViewCalls.at(-1),
    )
    pw(scrollCall).toEqual({ id: activeId, block: 'nearest' })
  } finally {
    await opened.close()
  }
})
