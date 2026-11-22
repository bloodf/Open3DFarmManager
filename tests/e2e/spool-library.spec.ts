import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Browser E2E tests for /bobinas/** against the real Nuxt app served by
// tests/e2e/e2e-web-server.mjs. All /api endpoints are mocked in-memory via
// Playwright route interception and non-loopback requests are aborted.
const FARM_ID = '00000000-0000-4000-8000-000000000539'

interface MockVendor {
  id: number
  registered: string
  name: string
  comment?: string | undefined
  empty_spool_weight?: number | undefined
  external_id?: string | undefined
  extra: Record<string, string>
}

interface MockFilament {
  id: number
  registered: string
  name?: string | undefined
  vendor?: MockVendor | undefined
  material?: string | undefined
  price?: number | undefined
  density: number
  diameter: number
  weight?: number | undefined
  spool_weight?: number | undefined
  article_number?: string | undefined
  comment?: string | undefined
  settings_extruder_temp?: number | undefined
  settings_bed_temp?: number | undefined
  color_hex?: string | undefined
  multi_color_hexes?: string | undefined
  multi_color_direction?: 'coaxial' | 'longitudinal' | undefined
  external_id?: string | undefined
  extra: Record<string, string>
}

interface MockSpool {
  id: number
  registered: string
  first_used?: string | undefined
  last_used?: string | undefined
  filament: MockFilament
  price?: number | undefined
  remaining_weight?: number | undefined
  initial_weight?: number | undefined
  spool_weight?: number | undefined
  used_weight: number
  remaining_length?: number | undefined
  used_length: number
  location?: string | undefined
  lot_nr?: string | undefined
  comment?: string | undefined
  archived: boolean
  extra: Record<string, string>
}

interface MockLibraryOptions {
  role?: 'owner' | 'operator' | 'viewer'
  delayImport?: () => Promise<void>
  failNextImportWith422?: boolean
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

function lengthFromWeight(weight: number, diameter: number, density: number) {
  const volumeMm3 = (weight / density) * 1000
  return volumeMm3 / (Math.PI * (diameter / 2) ** 2)
}

function recomputeSpool(spool: MockSpool): MockSpool {
  const base = spool.initial_weight ?? spool.filament.weight
  const remaining =
    base !== undefined ? Math.max(base - spool.used_weight, 0) : undefined
  return {
    ...spool,
    remaining_weight: remaining,
    remaining_length:
      remaining !== undefined
        ? lengthFromWeight(
            remaining,
            spool.filament.diameter,
            spool.filament.density,
          )
        : undefined,
    used_length: lengthFromWeight(
      spool.used_weight,
      spool.filament.diameter,
      spool.filament.density,
    ),
  }
}

async function installMockLibrary(
  page: Page,
  options: MockLibraryOptions = {},
) {
  const role = options.role ?? 'owner'
  const access =
    role === 'owner' ? 'manage' : role === 'operator' ? 'write' : 'read'
  const canWrite = access !== 'read'
  const canImport = access === 'manage'

  const vendors: MockVendor[] = [
    {
      id: 1,
      registered: '2026-11-18T10:00:00Z',
      name: 'Prusament',
      empty_spool_weight: 200,
      comment: 'Carretel hexagonal',
      extra: {},
    },
    {
      id: 2,
      registered: '2026-11-19T10:00:00Z',
      name: '3DLab',
      empty_spool_weight: 185,
      comment: 'Fornecedor nacional',
      extra: {},
    },
  ]

  const filaments: MockFilament[] = [
    {
      id: 1,
      registered: '2026-11-18T11:00:00Z',
      name: 'Galaxy Black',
      vendor: vendors[0],
      material: 'PLA',
      density: 1.24,
      diameter: 1.75,
      weight: 1000,
      spool_weight: 200,
      price: 189.9,
      settings_extruder_temp: 215,
      settings_bed_temp: 60,
      color_hex: '1C1F26',
      extra: {},
    },
    {
      id: 2,
      registered: '2026-11-19T11:00:00Z',
      name: 'Laranja Sinal',
      vendor: vendors[1],
      material: 'PETG',
      density: 1.27,
      diameter: 1.75,
      weight: 1000,
      spool_weight: 185,
      price: 129.0,
      settings_extruder_temp: 240,
      settings_bed_temp: 80,
      color_hex: 'E85D04',
      extra: {},
    },
  ]

  const spools: MockSpool[] = [
    recomputeSpool({
      id: 1,
      registered: '2026-11-18T12:00:00Z',
      last_used: '2026-11-20T09:30:00Z',
      filament: filaments[0]!,
      initial_weight: 1000,
      spool_weight: 200,
      used_weight: 250,
      used_length: 0,
      location: 'Estante A',
      lot_nr: 'LOTE-01',
      archived: false,
      extra: {},
    }),
    recomputeSpool({
      id: 2,
      registered: '2026-11-19T12:00:00Z',
      filament: filaments[1]!,
      initial_weight: 1000,
      spool_weight: 185,
      used_weight: 600,
      used_length: 0,
      location: 'Drybox 2',
      lot_nr: 'LOTE-02',
      archived: false,
      extra: {},
    }),
    recomputeSpool({
      id: 3,
      registered: '2026-11-10T12:00:00Z',
      filament: filaments[0]!,
      initial_weight: 1000,
      spool_weight: 200,
      used_weight: 990,
      used_length: 0,
      location: 'Arquivo',
      lot_nr: 'LOTE-00',
      archived: true,
      extra: {},
    }),
  ]

  let nextVendorId = 3
  let nextFilamentId = 3
  let nextSpoolId = 4
  let fail422 = options.failNextImportWith422 ?? false
  const importPayloads: Record<string, unknown>[] = []

  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  )
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'conta-bobinas' } }),
  )
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId: FARM_ID }], nextAfter: null } }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    route.fulfill({
      json: {
        currentAccountId: 'conta-bobinas',
        currentRole: role,
        devices: [],
        nextAfter: null,
      },
    }),
  )

  // Vendors routes
  await page.route(
    new RegExp(`/api/farms/${FARM_ID}/spool-library/vendors(?:$|/|\\?)`),
    async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const matchId = /\/vendors\/(\d+)$/.exec(url.pathname)

      if (req.method() === 'GET' && !matchId) {
        const q = normalize(url.searchParams.get('q') ?? '')
        const sort = url.searchParams.get('sort') ?? 'name:asc'
        let list = vendors.filter(
          (v) =>
            !q ||
            normalize(
              `${v.id} ${v.name} ${v.comment ?? ''} ${v.external_id ?? ''}`,
            ).includes(q),
        )
        if (sort === 'name:asc')
          list = [...list].sort((a, b) => a.name.localeCompare(b.name))
        else if (sort === 'name:desc')
          list = [...list].sort((a, b) => b.name.localeCompare(a.name))
        else if (sort === 'id:desc')
          list = [...list].sort((a, b) => b.id - a.id)
        const limit = url.searchParams.get('limit')
        const pageItems = limit ? list.slice(0, Number(limit)) : list
        return route.fulfill({
          json: {
            items: pageItems,
            total: list.length,
            access,
            canWrite,
            canImport,
          },
        })
      }

      if (req.method() === 'POST' && !matchId) {
        const body = req.postDataJSON() as Record<string, unknown>
        const created: MockVendor = {
          id: nextVendorId++,
          registered: '2026-11-21T15:00:00Z',
          name: String(body.name ?? ''),
          ...(typeof body.empty_spool_weight === 'number'
            ? { empty_spool_weight: body.empty_spool_weight }
            : {}),
          ...(typeof body.external_id === 'string' && body.external_id
            ? { external_id: body.external_id }
            : {}),
          ...(typeof body.comment === 'string' && body.comment
            ? { comment: body.comment }
            : {}),
          extra: {},
        }
        vendors.push(created)
        return route.fulfill({ status: 201, json: { item: created } })
      }

      if (matchId) {
        const id = Number(matchId[1])
        const idx = vendors.findIndex((v) => v.id === id)
        if (idx === -1)
          return route.fulfill({
            status: 404,
            json: { message: 'Fornecedor não encontrado.' },
          })
        if (req.method() === 'PATCH') {
          const body = req.postDataJSON() as Record<string, unknown>
          const updated: MockVendor = {
            ...vendors[idx]!,
            name:
              typeof body.name === 'string' ? body.name : vendors[idx]!.name,
            empty_spool_weight:
              typeof body.empty_spool_weight === 'number'
                ? body.empty_spool_weight
                : undefined,
            comment:
              typeof body.comment === 'string' ? body.comment : undefined,
          }
          vendors[idx] = updated
          return route.fulfill({ json: { item: updated } })
        }
        if (req.method() === 'DELETE') {
          vendors.splice(idx, 1)
          return route.fulfill({ json: { deleted: true } })
        }
      }
      return route.fulfill({ status: 405, json: {} })
    },
  )

  // Filaments routes
  await page.route(
    new RegExp(`/api/farms/${FARM_ID}/spool-library/filaments(?:$|/|\\?)`),
    async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const matchId = /\/filaments\/(\d+)$/.exec(url.pathname)

      if (req.method() === 'GET' && !matchId) {
        const q = normalize(url.searchParams.get('q') ?? '')
        const material = normalize(url.searchParams.get('material') ?? '')
        const vendorId = url.searchParams.get('vendor_id')
        const sort = url.searchParams.get('sort') ?? 'id:desc'
        let list = filaments.filter((f) => {
          if (material && normalize(f.material ?? '') !== material) return false
          if (vendorId && String(f.vendor?.id ?? '') !== vendorId) return false
          if (
            q &&
            !normalize(
              `${f.id} ${f.name ?? ''} ${f.material ?? ''} ${f.vendor?.name ?? ''}`,
            ).includes(q)
          )
            return false
          return true
        })
        if (sort === 'name:asc')
          list = [...list].sort((a, b) =>
            (a.name ?? '').localeCompare(b.name ?? ''),
          )
        else if (sort === 'id:desc')
          list = [...list].sort((a, b) => b.id - a.id)
        return route.fulfill({
          json: {
            items: list,
            total: list.length,
            access,
            canWrite,
            canImport,
          },
        })
      }

      if (req.method() === 'POST' && !matchId) {
        const body = req.postDataJSON() as Record<string, unknown>
        const vendor = vendors.find((v) => v.id === body.vendor_id)
        const created: MockFilament = {
          id: nextFilamentId++,
          registered: '2026-11-21T15:05:00Z',
          ...(typeof body.name === 'string' && body.name
            ? { name: body.name }
            : {}),
          ...(vendor ? { vendor } : {}),
          ...(typeof body.material === 'string' && body.material
            ? { material: body.material }
            : {}),
          density: Number(body.density ?? 1.24),
          diameter: Number(body.diameter ?? 1.75),
          ...(typeof body.weight === 'number' ? { weight: body.weight } : {}),
          ...(typeof body.spool_weight === 'number'
            ? { spool_weight: body.spool_weight }
            : vendor?.empty_spool_weight !== undefined
              ? { spool_weight: vendor.empty_spool_weight }
              : {}),
          ...(typeof body.price === 'number' ? { price: body.price } : {}),
          ...(typeof body.color_hex === 'string' && body.color_hex
            ? { color_hex: body.color_hex.replace(/^#/, '').toUpperCase() }
            : {}),
          ...(typeof body.multi_color_hexes === 'string' &&
          body.multi_color_hexes
            ? {
                multi_color_hexes: body.multi_color_hexes,
                multi_color_direction: body.multi_color_direction as
                  'coaxial' | 'longitudinal',
              }
            : {}),
          extra: {},
        }
        filaments.push(created)
        return route.fulfill({ status: 201, json: { item: created } })
      }

      if (matchId) {
        const id = Number(matchId[1])
        const idx = filaments.findIndex((f) => f.id === id)
        if (idx === -1)
          return route.fulfill({
            status: 404,
            json: { message: 'Filamento não encontrado.' },
          })
        if (req.method() === 'PATCH') {
          const body = req.postDataJSON() as Record<string, unknown>
          const updated: MockFilament = {
            ...filaments[idx]!,
            name:
              typeof body.name === 'string' ? body.name : filaments[idx]!.name,
            material:
              typeof body.material === 'string'
                ? body.material
                : filaments[idx]!.material,
          }
          filaments[idx] = updated
          return route.fulfill({ json: { item: updated } })
        }
        if (req.method() === 'DELETE') {
          if (spools.some((s) => s.filament.id === id)) {
            return route.fulfill({
              status: 409,
              json: {
                message:
                  'Não é possível excluir este filamento porque existem bobinas vinculadas a ele.',
              },
            })
          }
          filaments.splice(idx, 1)
          return route.fulfill({ json: { deleted: true } })
        }
      }
      return route.fulfill({ status: 405, json: {} })
    },
  )

  // Spools routes
  await page.route(
    new RegExp(`/api/farms/${FARM_ID}/spool-library/spools(?:$|/|\\?)`),
    async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const matchAction = /\/spools\/(\d+)\/(use|measure)$/.exec(url.pathname)
      const matchId = /\/spools\/(\d+)$/.exec(url.pathname)

      if (req.method() === 'GET' && !matchId && !matchAction) {
        const q = normalize(url.searchParams.get('q') ?? '')
        const material = normalize(
          url.searchParams.get('filament_material') ?? '',
        )
        const vendorId = url.searchParams.get('vendor_id')
        const location = normalize(url.searchParams.get('location') ?? '')
        const allowArchived = url.searchParams.get('allow_archived') === 'true'
        const sort = url.searchParams.get('sort') ?? 'id:desc'

        let list = spools.filter((s) => {
          if (!allowArchived && s.archived) return false
          if (material && normalize(s.filament.material ?? '') !== material)
            return false
          if (vendorId && String(s.filament.vendor?.id ?? '') !== vendorId)
            return false
          if (location && !normalize(s.location ?? '').includes(location))
            return false
          if (
            q &&
            !normalize(
              `#${s.id} ${s.filament.name ?? ''} ${s.filament.material ?? ''} ${s.filament.vendor?.name ?? ''} ${s.location ?? ''} ${s.lot_nr ?? ''}`,
            ).includes(q)
          )
            return false
          return true
        })

        if (sort === 'remaining_weight:asc')
          list = [...list].sort(
            (a, b) =>
              (a.remaining_weight ?? Infinity) -
              (b.remaining_weight ?? Infinity),
          )
        else if (sort === 'remaining_weight:desc')
          list = [...list].sort(
            (a, b) => (b.remaining_weight ?? -1) - (a.remaining_weight ?? -1),
          )
        else if (sort === 'id:asc') list = [...list].sort((a, b) => a.id - b.id)
        else list = [...list].sort((a, b) => b.id - a.id)

        return route.fulfill({
          json: {
            items: list,
            total: list.length,
            access,
            canWrite,
            canImport,
          },
        })
      }

      if (req.method() === 'POST' && !matchId && !matchAction) {
        const body = req.postDataJSON() as Record<string, unknown>
        const filament = filaments.find((f) => f.id === body.filament_id)
        if (!filament)
          return route.fulfill({
            status: 404,
            json: { message: 'Filamento não encontrado.' },
          })
        const initial =
          typeof body.initial_weight === 'number'
            ? body.initial_weight
            : filament.weight
        const used =
          typeof body.remaining_weight === 'number' && initial !== undefined
            ? Math.max(initial - body.remaining_weight, 0)
            : typeof body.used_weight === 'number'
              ? body.used_weight
              : 0
        const created = recomputeSpool({
          id: nextSpoolId++,
          registered: '2026-11-21T15:10:00Z',
          filament,
          initial_weight: initial,
          spool_weight:
            typeof body.spool_weight === 'number'
              ? body.spool_weight
              : filament.spool_weight,
          used_weight: used,
          used_length: 0,
          location:
            typeof body.location === 'string' ? body.location : undefined,
          lot_nr: typeof body.lot_nr === 'string' ? body.lot_nr : undefined,
          comment: typeof body.comment === 'string' ? body.comment : undefined,
          archived: Boolean(body.archived),
          extra: {},
        })
        spools.push(created)
        return route.fulfill({ status: 201, json: { item: created } })
      }

      if (matchAction && req.method() === 'PUT') {
        const id = Number(matchAction[1])
        const action = matchAction[2]
        const idx = spools.findIndex((s) => s.id === id)
        if (idx === -1)
          return route.fulfill({
            status: 404,
            json: { message: 'Bobina não encontrada.' },
          })
        const body = req.postDataJSON() as Record<string, unknown>
        const current = spools[idx]!
        if (action === 'use') {
          const delta = Number(body.use_weight ?? 0)
          const updated = recomputeSpool({
            ...current,
            used_weight: current.used_weight + delta,
            last_used: '2026-11-21T15:15:00Z',
          })
          spools[idx] = updated
          return route.fulfill({ json: { item: updated } })
        }
        const gross = Number(body.weight)
        const tare = current.spool_weight ?? current.filament.spool_weight ?? 0
        const base = current.initial_weight ?? current.filament.weight ?? 0
        const nextRemaining = Math.max(gross - tare, 0)
        const updated = recomputeSpool({
          ...current,
          used_weight: Math.max(base - nextRemaining, 0),
          last_used: '2026-11-21T15:16:00Z',
        })
        spools[idx] = updated
        return route.fulfill({ json: { item: updated } })
      }

      if (matchId) {
        const id = Number(matchId[1])
        const idx = spools.findIndex((s) => s.id === id)
        if (idx === -1)
          return route.fulfill({
            status: 404,
            json: { message: 'Bobina não encontrada.' },
          })
        if (req.method() === 'PATCH') {
          const body = req.postDataJSON() as Record<string, unknown>
          const current = spools[idx]!
          const updated = recomputeSpool({
            ...current,
            ...(typeof body.archived === 'boolean'
              ? { archived: body.archived }
              : {}),
            ...(typeof body.location === 'string'
              ? { location: body.location }
              : {}),
            ...(typeof body.lot_nr === 'string' ? { lot_nr: body.lot_nr } : {}),
          })
          spools[idx] = updated
          return route.fulfill({ json: { item: updated } })
        }
        if (req.method() === 'DELETE') {
          spools.splice(idx, 1)
          return route.fulfill({ json: { deleted: true } })
        }
      }

      return route.fulfill({ status: 405, json: {} })
    },
  )

  // Import route
  await page.route(
    `**/api/farms/${FARM_ID}/spool-library/import`,
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      importPayloads.push(body)
      if (options.delayImport) await options.delayImport()
      if (fail422) {
        fail422 = false
        return route.fulfill({
          status: 422,
          json: {
            message: 'Os dados importados são inválidos.',
            data: {
              problems: [
                {
                  path: 'spools[0].filament_id',
                  problem: 'referência ausente',
                },
              ],
            },
          },
        })
      }
      const zero = {
        created: 0,
        updated: 0,
        unchanged: 0,
        adopted: 0,
        conflicts: 0,
      }
      return route.fulfill({
        json: {
          report: {
            runId: 'abcdef12-0000-4000-8000-000000000001',
            dryRun: Boolean(body.dryRun),
            sourceKey: String(body.source ?? `${body.format}-default`),
            vendors: { ...zero, created: 2, adopted: 1 },
            filaments: { ...zero, created: 3, updated: 1 },
            spools: { ...zero, created: 4, conflicts: 1 },
            fields: zero,
            settings: zero,
            truncated: 1,
            skippedSettings: ['base_url'],
            conflicts: [{ kind: 'spool', id: '42' }],
          },
        },
      })
    },
  )

  return { importPayloads }
}

async function waitHydrated(page: Page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
}

async function assertAxeClean(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(
    violations
      .filter(({ impact }) => impact === 'serious' || impact === 'critical')
      .map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
    label,
  ).toEqual([])
}

test('operator browses, searches, filters, sorts, creates, edits, archives, uses, weighs and deletes spools', async ({
  page,
}) => {
  await installMockLibrary(page, { role: 'owner' })
  await page.goto('/bobinas')
  await waitHydrated(page)

  // Main navigation exposes both /bobinas and /spoolman
  const mainNav = page
    .getByRole('complementary')
    .getByRole('navigation', { name: 'Navegação principal' })
  await expect(
    mainNav.getByRole('link', { name: 'Bobinas', exact: true }),
  ).toHaveAttribute('href', '/bobinas')
  await expect(
    mainNav.getByRole('link', { name: 'Spoolman', exact: true }),
  ).toHaveAttribute('href', '/spoolman')

  // Initial list hides archived spool #3
  await expect(page.getByText('2 bobina(s) encontrada(s).')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: /Prusament · Galaxy Black/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: /3DLab · Laranja Sinal/ }),
  ).toBeVisible()

  // Show archived & filter by material
  await page.getByLabel('Mostrar arquivadas').check()
  await expect(page.getByText('3 bobina(s) encontrada(s).')).toBeVisible()
  await page.getByLabel('Material').selectOption('PETG')
  await expect(page.getByText('1 bobina(s) encontrada(s).')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: /3DLab · Laranja Sinal/ }),
  ).toBeVisible()

  // Clear filters and sort by remaining weight ascending
  await page.getByRole('button', { name: 'Limpar', exact: true }).click()
  await expect(page.getByText('2 bobina(s) encontrada(s).')).toBeVisible()
  await page.getByLabel('Ordenar por').selectOption('remaining_weight:asc')
  const firstHeading = page.locator('article h3').first()
  await expect(firstHeading).toContainText('Laranja Sinal')

  // Create a new spool
  await page.getByRole('button', { name: 'Nova bobina', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: 'Nova bobina' })
  await expect(createDialog).toBeVisible()
  await createDialog.getByLabel('Peso restante (g)').fill('900')
  await createDialog.getByLabel('Localização').fill('Prateleira Nova')
  await createDialog.getByRole('button', { name: 'Salvar bobina' }).click()
  await expect(createDialog).toBeHidden()
  await expect(page.getByText('Bobina #4 cadastrada.')).toBeVisible()
  await expect(page.getByText('Prateleira Nova')).toBeVisible()

  // Record use on spool #1 (750 g -> 700 g)
  await page.getByRole('button', { name: 'Registrar uso da bobina #1' }).click()
  const useDialog = page.getByRole('dialog', {
    name: 'Registrar uso · Bobina #1',
  })
  await useDialog.getByLabel('Peso consumido (g)').fill('50')
  await expect(useDialog.getByText(/Novo restante: 700/)).toBeVisible()
  await useDialog.getByRole('button', { name: 'Confirmar uso' }).click()
  await expect(useDialog).toBeHidden()
  await expect(page.getByText('Uso registrado na bobina #1.')).toBeVisible()

  // Record scale measure on spool #1 (800 g gross - 200 g tare = 600 g)
  await page.getByRole('button', { name: 'Pesar bobina #1' }).click()
  const measureDialog = page.getByRole('dialog', {
    name: 'Registrar pesagem · Bobina #1',
  })
  await measureDialog.getByLabel('Peso bruto na balança (g)').fill('800')
  await expect(measureDialog.getByText(/600/)).toBeVisible()
  await measureDialog.getByRole('button', { name: 'Confirmar pesagem' }).click()
  await expect(measureDialog).toBeHidden()
  await expect(page.getByText('Pesagem registrada na bobina #1.')).toBeVisible()

  // Archive spool #4
  await page.getByRole('button', { name: 'Arquivar bobina #4' }).click()
  await expect(page.getByText('Bobina #4 arquivada.')).toBeVisible()

  // Edit and delete spool #2
  await page.getByRole('button', { name: 'Editar bobina #2' }).click()
  const editDialog = page.getByRole('dialog', { name: 'Editar bobina #2' })
  await editDialog.getByLabel('Localização').fill('Drybox Editada')
  await editDialog.getByRole('button', { name: 'Salvar bobina' }).click()
  await expect(editDialog).toBeHidden()
  await expect(page.getByText('Drybox Editada')).toBeVisible()

  await page.getByRole('button', { name: 'Excluir bobina #2' }).click()
  const deleteDialog = page.getByRole('dialog', { name: 'Excluir bobina #2' })
  await deleteDialog
    .getByRole('button', { name: 'Excluir', exact: true })
    .click()
  await expect(deleteDialog).toBeHidden()
  await expect(page.getByText('Bobina #2 excluída.')).toBeVisible()
})

test('operator manages filaments and vendors including conflict feedback', async ({
  page,
}) => {
  await installMockLibrary(page, { role: 'operator' })

  // Filaments page
  await page.goto('/bobinas/filamentos')
  await waitHydrated(page)
  await expect(page.getByText('2 filamento(s) encontrado(s).')).toBeVisible()

  // Create filament
  await page
    .getByRole('button', { name: 'Novo filamento', exact: true })
    .click()
  const filDialog = page.getByRole('dialog', { name: 'Novo filamento' })
  await filDialog.getByLabel('Nome').fill('Verde Floresta')
  await filDialog.getByLabel('Material').fill('ASA')
  await filDialog.getByLabel('Fornecedor').selectOption('1')
  await filDialog.getByRole('button', { name: 'Salvar filamento' }).click()
  await expect(filDialog).toBeHidden()
  await expect(page.getByText('Filamento #3 cadastrado.')).toBeVisible()
  await expect(page.getByText('Prusament · Verde Floresta')).toBeVisible()

  // Deleting filament #1 linked to spools displays clear 409 error
  await page.getByRole('button', { name: 'Excluir filamento #1' }).click()
  const conflictDialog = page.getByRole('dialog', {
    name: 'Excluir filamento #1',
  })
  await conflictDialog
    .getByRole('button', { name: 'Excluir', exact: true })
    .click()
  await expect(conflictDialog.getByRole('alert')).toContainText(
    'existem bobinas vinculadas',
  )
  await conflictDialog.getByRole('button', { name: 'Cancelar' }).click()

  // Deleting unlinked filament #3 succeeds
  await page.getByRole('button', { name: 'Excluir filamento #3' }).click()
  const deleteFilDialog = page.getByRole('dialog', {
    name: 'Excluir filamento #3',
  })
  await deleteFilDialog
    .getByRole('button', { name: 'Excluir', exact: true })
    .click()
  await expect(deleteFilDialog).toBeHidden()
  await expect(page.getByText('Filamento #3 excluído.')).toBeVisible()

  // Vendors page via subnav
  await page
    .getByRole('navigation', { name: 'Seções da biblioteca de bobinas' })
    .getByRole('link', { name: 'Fornecedores' })
    .click()
  await expect(page).toHaveURL(/\/bobinas\/fornecedores/)
  await expect(page.getByText('2 fornecedor(es) encontrado(s).')).toBeVisible()

  await page
    .getByRole('button', { name: 'Novo fornecedor', exact: true })
    .click()
  const venDialog = page.getByRole('dialog', { name: 'Novo fornecedor' })
  await venDialog.getByLabel('Nome *').fill('Bambu Lab')
  await venDialog.getByLabel('Peso do carretel vazio (g)').fill('250')
  await venDialog.getByRole('button', { name: 'Salvar fornecedor' }).click()
  await expect(venDialog).toBeHidden()
  await expect(page.getByText('Fornecedor #3 cadastrado.')).toBeVisible()
  await expect(page.getByText('Bambu Lab')).toBeVisible()
})

test('viewer has read-only access across inventory and import pages', async ({
  page,
}) => {
  await installMockLibrary(page, { role: 'viewer' })
  await page.goto('/bobinas')
  await waitHydrated(page)
  await expect(page.getByText('Modo somente leitura.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nova bobina' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Registrar uso/ })).toHaveCount(
    0,
  )

  await page.goto('/bobinas/importar')
  await waitHydrated(page)
  await expect(
    page.getByText('Apenas proprietários e administradores podem importar'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: /Simular importação|Executar importação/,
    }),
  ).toHaveCount(0)
})

test('owner runs Spoolman API, JSON (with 422 feedback) and CSV import with progress and report', async ({
  page,
}) => {
  let releaseImport = () => {}
  let gate: Promise<void> | undefined
  const { importPayloads } = await installMockLibrary(page, {
    role: 'owner',
    delayImport: () => gate ?? Promise.resolve(),
    failNextImportWith422: true,
  })

  await page.goto('/bobinas/importar')
  await waitHydrated(page)

  // 1. JSON validation error (422) renders structured problems list
  await page.getByRole('button', { name: 'Arquivo JSON' }).click()
  await page.getByLabel('Conteúdo JSON *').fill('{"spools":[{"id":1}]}')
  await page.getByRole('button', { name: 'Simular importação' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Os dados importados são inválidos.')
  await expect(alert).toContainText('spools[0].filament_id')

  // 2. Spoolman API dry-run shows progress bar while pending, then report + apply
  gate = new Promise<void>((resolve) => {
    releaseImport = resolve
  })
  await page.getByRole('button', { name: 'API do Spoolman' }).click()
  await page
    .getByLabel('Endereço do Spoolman *')
    .fill('http://spoolman.lan:7912')
  await page.getByLabel('Token Bearer (opcional)').fill('synthetic-token-123')
  await page.getByRole('button', { name: 'Simular importação' }).click()

  await expect(page.getByText(/Simulando importação/)).toBeVisible()
  await expect(
    page.getByRole('progressbar', { name: 'Progresso da importação' }),
  ).toBeVisible()
  // Token field is cleared immediately upon submission
  await expect(page.getByLabel('Token Bearer (opcional)')).toHaveValue('')

  releaseImport()
  gate = undefined

  await expect(
    page.getByRole('heading', { name: 'Resultado da importação' }),
  ).toBeVisible()
  await expect(
    page.getByText(/Simulação concluída sem gravar alterações/),
  ).toBeVisible()
  await expect(page.getByText('Conflitos detectados (1)')).toBeVisible()
  await expect(
    page.getByText(/Configurações ignoradas da origem: base_url/),
  ).toBeVisible()

  // Apply real import directly from dry-run report
  await page.getByRole('button', { name: 'Aplicar importação agora' }).click()
  await expect(page.getByText(/Importação aplicada com sucesso/)).toBeVisible()

  // 3. CSV import
  await page.getByRole('button', { name: 'Arquivo CSV' }).click()
  await page.getByLabel('Tipo de registro no CSV *').selectOption('vendors')
  await page.getByLabel('Conteúdo CSV *').fill('id,name\n1,Prusament\n')
  await page.getByLabel(/Simulação/).uncheck()
  await page.getByRole('button', { name: 'Executar importação' }).click()
  await expect(page.getByText(/Importação aplicada com sucesso/)).toBeVisible()

  expect(importPayloads.map((p) => p.format)).toEqual([
    'json',
    'spoolman-api',
    'spoolman-api',
    'csv',
  ])
})

for (const path of [
  '/bobinas',
  '/bobinas/filamentos',
  '/bobinas/fornecedores',
  '/bobinas/importar',
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${path} is axe-clean and has no horizontal overflow at phone and desktop widths in ${theme} theme`, async ({
      page,
    }) => {
      await installMockLibrary(page, { role: 'owner' })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript(
        (value) => localStorage.setItem('farm-theme', value),
        theme,
      )

      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(path)
        await waitHydrated(page)
        await expect(page.locator('main')).toBeVisible()
        await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
        await assertAxeClean(page, `${path} at ${width}px (${theme})`)
        const fits = await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        )
        expect(fits, `${path} horizontal overflow at ${width}px`).toBe(true)
      }
    })
  }
}
