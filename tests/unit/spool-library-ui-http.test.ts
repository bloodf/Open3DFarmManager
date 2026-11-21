import { beforeAll, describe, expect, test } from 'vitest'
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { spoolLibraryResource } from '../../apps/farm/server/services/spool-library-http.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type {
  Result,
  Spool,
  SpoolFilament,
  SpoolFilamentInput,
  SpoolInput,
  SpoolLibraryAccess,
  SpoolLibraryRepository,
  SpoolLibraryStorage,
  SpoolVendor,
  SpoolVendorInput,
} from '../../apps/farm/server/utils/spool-library/scope.ts'

const origin = 'https://farm.example.invalid'
const farmId = '22222222-2222-4222-8222-222222222222'
let cookie = ''

const cookieConfig = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-spool-ui-test-secret-32-chars',
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
} satisfies AuthRuntime['cookie']

function createMemoryStorage(access: SpoolLibraryAccess): SpoolLibraryStorage {
  let nextVendor = 1
  let nextFilament = 1
  let nextSpool = 1
  const vendors = new Map<number, SpoolVendor>()
  const filaments = new Map<number, SpoolFilament>()
  const spools = new Map<number, Spool>()
  let now = Date.UTC(2026, 10, 20, 12, 0)

  const ok = <T>(value: T): Result<T> => ({ ok: true, value })
  const fail = (reason: 'not-found' | 'denied' | 'conflict') => ({
    ok: false as const,
    reason,
  })

  const pageOf = <T extends { id: number }>(
    items: Iterable<T>,
    afterId = 0,
    limit = 500,
  ) =>
    [...items]
      .sort((a, b) => a.id - b.id)
      .filter((item) => item.id > afterId)
      .slice(0, limit)

  const repository: SpoolLibraryRepository = {
    farmId,
    access,
    extraFields: {
      async list() {
        return ok([])
      },
      async upsert() {
        return ok(true as const)
      },
      async delete() {
        return ok(true as const)
      },
    },
    settings: {
      async list() {
        return ok([])
      },
      async set() {
        return ok(true as const)
      },
      async reset() {
        return ok(true as const)
      },
    },
    locations: {
      async list() {
        return ok([])
      },
    },
    async renameSpoolFieldValue() {
      return ok(0)
    },
    vendors: {
      async list(page) {
        return ok(pageOf(vendors.values(), page.afterId, page.limit))
      },
      async get(id) {
        const found = vendors.get(id)
        return found ? ok(found) : fail('not-found')
      },
      async create(input: SpoolVendorInput) {
        if (access === 'read') return fail('denied')
        const record: SpoolVendor = {
          id: nextVendor++,
          name: input.name,
          comment: input.comment ?? null,
          emptySpoolWeight: input.emptySpoolWeight ?? null,
          externalId: input.externalId ?? null,
          extra: input.extra ?? {},
          registeredAt: (now += 1000),
        }
        vendors.set(record.id, record)
        return ok(record)
      },
      async update(id, patch) {
        if (access === 'read') return fail('denied')
        const current = vendors.get(id)
        if (!current) return fail('not-found')
        const updated: SpoolVendor = { ...current, ...patch }
        vendors.set(id, updated)
        return ok(updated)
      },
      async delete(id) {
        if (access === 'read') return fail('denied')
        if (!vendors.delete(id)) return fail('not-found')
        for (const [fId, filament] of filaments) {
          if (filament.vendorId === id) {
            filaments.set(fId, { ...filament, vendorId: null })
          }
        }
        return ok(true)
      },
    },
    filaments: {
      async list(page) {
        return ok(pageOf(filaments.values(), page.afterId, page.limit))
      },
      async get(id) {
        const found = filaments.get(id)
        return found ? ok(found) : fail('not-found')
      },
      async create(input: SpoolFilamentInput) {
        if (access === 'read') return fail('denied')
        const record: SpoolFilament = {
          id: nextFilament++,
          vendorId: input.vendorId ?? null,
          name: input.name ?? null,
          material: input.material ?? null,
          colorHex: input.colorHex ?? null,
          multiColorHexes: input.multiColorHexes ?? null,
          multiColorDirection: input.multiColorDirection ?? null,
          articleNumber: input.articleNumber ?? null,
          settingsExtruderTemp: input.settingsExtruderTemp ?? null,
          settingsBedTemp: input.settingsBedTemp ?? null,
          density: input.density,
          diameter: input.diameter,
          weight: input.weight ?? null,
          spoolWeight: input.spoolWeight ?? null,
          price: input.price ?? null,
          comment: input.comment ?? null,
          externalId: input.externalId ?? null,
          extra: input.extra ?? {},
          registeredAt: (now += 1000),
        }
        filaments.set(record.id, record)
        return ok(record)
      },
      async update(id, patch) {
        if (access === 'read') return fail('denied')
        const current = filaments.get(id)
        if (!current) return fail('not-found')
        const updated: SpoolFilament = { ...current, ...patch }
        filaments.set(id, updated)
        return ok(updated)
      },
      async delete(id) {
        if (access === 'read') return fail('denied')
        if (!filaments.has(id)) return fail('not-found')
        for (const spool of spools.values()) {
          if (spool.filamentId === id) return fail('conflict')
        }
        filaments.delete(id)
        return ok(true)
      },
    },
    spools: {
      async list(page) {
        return ok(pageOf(spools.values(), page.afterId, page.limit))
      },
      async get(id) {
        const found = spools.get(id)
        return found ? ok(found) : fail('not-found')
      },
      async create(input: SpoolInput) {
        if (access === 'read') return fail('denied')
        const record: Spool = {
          id: nextSpool++,
          filamentId: input.filamentId,
          initialWeight: input.initialWeight ?? null,
          spoolWeight: input.spoolWeight ?? null,
          usedWeight: input.usedWeight ?? 0,
          price: input.price ?? null,
          location: input.location ?? null,
          lotNr: input.lotNr ?? null,
          comment: input.comment ?? null,
          archived: input.archived ?? false,
          extra: input.extra ?? {},
          registeredAt: (now += 1000),
          firstUsedAt: input.firstUsedAt ?? null,
          lastUsedAt: input.lastUsedAt ?? null,
        }
        spools.set(record.id, record)
        return ok(record)
      },
      async update(id, patch) {
        if (access === 'read') return fail('denied')
        const current = spools.get(id)
        if (!current) return fail('not-found')
        const updated: Spool = { ...current, ...patch }
        spools.set(id, updated)
        return ok(updated)
      },
      async delete(id) {
        if (access === 'read') return fail('denied')
        return spools.delete(id) ? ok(true) : fail('not-found')
      },
      async use(id, grams) {
        if (access === 'read') return fail('denied')
        const current = spools.get(id)
        if (!current) return fail('not-found')
        const stamp = (now += 1000)
        const updated: Spool = {
          ...current,
          usedWeight: current.usedWeight + grams,
          firstUsedAt: current.firstUsedAt ?? stamp,
          lastUsedAt: stamp,
        }
        spools.set(id, updated)
        return ok(updated)
      },
    },
  }

  return {
    async withScope(authority, work) {
      if (authority.kind !== 'session' || authority.farmId !== farmId) {
        return { ok: false, reason: 'forbidden' }
      }
      return work(repository)
    },
    async issueLegacyCredential() {
      return fail('denied')
    },
    async listLegacyCredentials() {
      return fail('denied')
    },
    async revokeLegacyCredential() {
      return fail('denied')
    },
  }
}

function createAuth(): AuthRuntime {
  return {
    origin,
    cookie: cookieConfig,
    idleTimeoutMs: 60_000,
    lifetimeMs: 3_600_000,
    sessions: {
      async authorizeAndTouch() {
        return { ok: true, accountId: 'acc-1', touchAt: Date.now() }
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit() {
        return true
      },
      async find() {
        return null
      },
      async issue() {
        return 'spool-ui-session-1'
      },
    },
  }
}

function makeEvent(
  method: string,
  path: string,
  options: {
    body?: unknown
    sessionCookie?: string
    reqOrigin?: string
    contentType?: string
  } = {},
) {
  const headers = new Headers()
  if (options.sessionCookie !== '') {
    headers.set('cookie', options.sessionCookie ?? cookie)
  }
  if (options.reqOrigin !== '') {
    headers.set('origin', options.reqOrigin ?? origin)
  }
  if (options.body !== undefined) {
    headers.set('content-type', options.contentType ?? 'application/json')
  }
  const req = new Request(`${origin}${path}`, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : {
          body:
            typeof options.body === 'string'
              ? options.body
              : JSON.stringify(options.body),
        }),
  })
  return { req, res: { headers: new Headers(), status: 200 } }
}

beforeAll(async () => {
  const auth = createAuth()
  const passwordHash = await hashPassword('synthetic-test-password')
  auth.credentials.find = async () => ({
    accountId: 'acc-1',
    passwordHash,
    credentialVersion: '1',
    sessionVersion: '1',
  })
  const event = {
    req: new Request(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'operator_one',
        password: 'synthetic-test-password',
      }),
    }),
    res: { headers: new Headers() },
  }
  await login(event, auth)
  cookie = event.res.headers.get('set-cookie')!.split(';')[0]!
})

describe('session-authenticated spool-library farm API', () => {
  test('enforces session cookie, origin boundary, and viewer read-only permissions', async () => {
    const auth = createAuth()
    const readStorage = createMemoryStorage('read')

    await expect(
      spoolLibraryResource(
        makeEvent('GET', `/api/farms/${farmId}/spool-library/vendors`, {
          sessionCookie: '',
        }),
        { farmId, resource: 'vendors' },
        { auth, storage: readStorage },
      ),
    ).rejects.toMatchObject({ status: 401 })

    await expect(
      spoolLibraryResource(
        makeEvent('POST', `/api/farms/${farmId}/spool-library/vendors`, {
          body: { name: 'Cross Origin' },
          reqOrigin: 'https://evil.example.invalid',
        }),
        { farmId, resource: 'vendors' },
        { auth, storage: readStorage },
      ),
    ).rejects.toMatchObject({ status: 403 })

    const viewerList = await spoolLibraryResource(
      makeEvent('GET', `/api/farms/${farmId}/spool-library/vendors`),
      { farmId, resource: 'vendors' },
      { auth, storage: readStorage },
    )
    expect(viewerList).toEqual({
      items: [],
      total: 0,
      access: 'read',
      canWrite: false,
      canImport: false,
    })

    await expect(
      spoolLibraryResource(
        makeEvent('POST', `/api/farms/${farmId}/spool-library/vendors`, {
          body: { name: 'Blocked' },
        }),
        { farmId, resource: 'vendors' },
        { auth, storage: readStorage },
      ),
    ).rejects.toMatchObject({ status: 403 })
  })

  test('supports full operator lifecycle for vendors, filaments, spools, archive, use, measure, search and delete', async () => {
    const auth = createAuth()
    const storage = createMemoryStorage('write')
    const deps = { auth, storage }

    // 1. Create vendor
    const createVendorEvent = makeEvent(
      'POST',
      `/api/farms/${farmId}/spool-library/vendors`,
      { body: { name: 'Prusament', empty_spool_weight: 200 } },
    )
    const vendorCreated = (await spoolLibraryResource(
      createVendorEvent,
      { farmId, resource: 'vendors' },
      deps,
    )) as { item: { id: number; name: string; empty_spool_weight: number } }
    expect(createVendorEvent.res.status).toBe(201)
    expect(vendorCreated.item).toMatchObject({
      id: 1,
      name: 'Prusament',
      empty_spool_weight: 200,
    })

    // 2. Create filament inheriting vendor empty_spool_weight
    const filamentCreated = (await spoolLibraryResource(
      makeEvent('POST', `/api/farms/${farmId}/spool-library/filaments`, {
        body: {
          name: 'Jet Black',
          vendor_id: 1,
          material: 'PETG',
          density: 1.27,
          diameter: 1.75,
          weight: 1000,
          color_hex: '#112233',
        },
      }),
      { farmId, resource: 'filaments' },
      deps,
    )) as { item: { id: number; spool_weight: number; color_hex: string } }
    expect(filamentCreated.item).toMatchObject({
      id: 1,
      spool_weight: 200,
      color_hex: '112233',
    })

    // 3. Create two spools (one active, one archived)
    const spoolA = (await spoolLibraryResource(
      makeEvent('POST', `/api/farms/${farmId}/spool-library/spools`, {
        body: {
          filament_id: 1,
          remaining_weight: 800,
          location: 'Estante A',
          lot_nr: 'LOT-01',
        },
      }),
      { farmId, resource: 'spools' },
      deps,
    )) as {
      item: { id: number; used_weight: number; remaining_weight: number }
    }
    expect(spoolA.item).toMatchObject({
      id: 1,
      used_weight: 200,
      remaining_weight: 800,
    })

    await spoolLibraryResource(
      makeEvent('POST', `/api/farms/${farmId}/spool-library/spools`, {
        body: {
          filament_id: 1,
          remaining_weight: 500,
          location: 'Armário B',
          archived: true,
        },
      }),
      { farmId, resource: 'spools' },
      deps,
    )

    // 4. List spools excludes archived by default and supports accent-insensitive q search
    const activeOnly = (await spoolLibraryResource(
      makeEvent('GET', `/api/farms/${farmId}/spool-library/spools`),
      { farmId, resource: 'spools' },
      deps,
    )) as {
      items: unknown[]
      total: number
      canWrite: boolean
      canImport: boolean
    }
    expect(activeOnly.total).toBe(1)
    expect(activeOnly.canWrite).toBe(true)
    expect(activeOnly.canImport).toBe(false)

    const searchArchived = (await spoolLibraryResource(
      makeEvent(
        'GET',
        `/api/farms/${farmId}/spool-library/spools?allow_archived=true&q=armario&sort=remaining_weight:asc`,
      ),
      { farmId, resource: 'spools' },
      deps,
    )) as unknown as { items: { id: number }[]; total: number }
    expect(searchArchived.total).toBe(1)
    expect(searchArchived.items[0]?.id).toBe(2)

    // 5. Record use (by grams) and scale measure
    const afterUse = (await spoolLibraryResource(
      makeEvent('PUT', `/api/farms/${farmId}/spool-library/spools/1/use`, {
        body: { use_weight: 50 },
      }),
      { farmId, resource: 'spools', id: '1', action: 'use' },
      deps,
    )) as { item: { remaining_weight: number; used_weight: number } }
    expect(afterUse.item.used_weight).toBe(250)
    expect(afterUse.item.remaining_weight).toBe(750)

    const afterMeasure = (await spoolLibraryResource(
      makeEvent('PUT', `/api/farms/${farmId}/spool-library/spools/1/measure`, {
        body: { weight: 800 },
      }),
      { farmId, resource: 'spools', id: '1', action: 'measure' },
      deps,
    )) as { item: { remaining_weight: number } }
    // 800g gross - 200g tare = 600g remaining
    expect(afterMeasure.item.remaining_weight).toBe(600)

    // 6. Deleting filament while spools reference it returns 409 conflict
    await expect(
      spoolLibraryResource(
        makeEvent('DELETE', `/api/farms/${farmId}/spool-library/filaments/1`),
        { farmId, resource: 'filaments', id: '1' },
        deps,
      ),
    ).rejects.toMatchObject({ status: 409 })

    // 7. Archive and delete spools, then delete filament and vendor
    const archived = (await spoolLibraryResource(
      makeEvent('PATCH', `/api/farms/${farmId}/spool-library/spools/1`, {
        body: { archived: true },
      }),
      { farmId, resource: 'spools', id: '1' },
      deps,
    )) as { item: { archived: boolean } }
    expect(archived.item.archived).toBe(true)

    expect(
      await spoolLibraryResource(
        makeEvent('DELETE', `/api/farms/${farmId}/spool-library/spools/1`),
        { farmId, resource: 'spools', id: '1' },
        deps,
      ),
    ).toEqual({ deleted: true })
    expect(
      await spoolLibraryResource(
        makeEvent('DELETE', `/api/farms/${farmId}/spool-library/spools/2`),
        { farmId, resource: 'spools', id: '2' },
        deps,
      ),
    ).toEqual({ deleted: true })
    expect(
      await spoolLibraryResource(
        makeEvent('DELETE', `/api/farms/${farmId}/spool-library/filaments/1`),
        { farmId, resource: 'filaments', id: '1' },
        deps,
      ),
    ).toEqual({ deleted: true })
    expect(
      await spoolLibraryResource(
        makeEvent('DELETE', `/api/farms/${farmId}/spool-library/vendors/1`),
        { farmId, resource: 'vendors', id: '1' },
        deps,
      ),
    ).toEqual({ deleted: true })
  })

  test('reports canImport: true for manage access and maps validation errors to 422', async () => {
    const auth = createAuth()
    const storage = createMemoryStorage('manage')
    const list = (await spoolLibraryResource(
      makeEvent('GET', `/api/farms/${farmId}/spool-library/spools`),
      { farmId, resource: 'spools' },
      { auth, storage },
    )) as { canWrite: boolean; canImport: boolean; access: string }
    expect(list).toMatchObject({
      access: 'manage',
      canWrite: true,
      canImport: true,
    })

    await expect(
      spoolLibraryResource(
        makeEvent('POST', `/api/farms/${farmId}/spool-library/filaments`, {
          body: { density: -1, diameter: 1.75 },
        }),
        { farmId, resource: 'filaments' },
        { auth, storage },
      ),
    ).rejects.toMatchObject({ status: 422 })
  })
})
