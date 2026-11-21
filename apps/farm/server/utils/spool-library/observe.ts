/**
 * Records the changes a request makes through a farm-bound repository, as
 * upstream Spoolman change events, without touching the endpoint modules.
 *
 * The wrapper sits between the modules and the repository. Each successful
 * mutation appends one event (payload shaped exactly like the HTTP response of
 * that entity) to a list the caller publishes only after the transaction has
 * committed, so a rolled-back request emits nothing. Reads that build a payload
 * run inside the same transaction. Capturing never changes a mutation's result:
 * a payload that cannot be built is skipped.
 */
import {
  loadAll,
  filamentJson,
  spoolJson,
  vendorJson,
} from './legacy-api/records.ts'
import { SETTING_DEFINITIONS, settingViews } from './legacy-api/setting.ts'
import {
  buildFeedEvent,
  type SpoolEventType,
  type SpoolFeedEvent,
} from './events.ts'
import type {
  Result,
  Spool,
  SpoolFilament,
  SpoolLibraryRepository,
  SpoolRecordId,
  SpoolVendor,
} from './scope.ts'

export interface ObserveOptions {
  now?: () => number
}

export function observeRepository(
  repo: SpoolLibraryRepository,
  events: SpoolFeedEvent[],
  options: ObserveOptions = {},
): SpoolLibraryRepository {
  const now = options.now ?? Date.now
  const push = (
    type: SpoolEventType,
    resource: 'vendor' | 'filament' | 'spool',
    id: SpoolRecordId,
    payload: Record<string, unknown>,
  ) => events.push(buildFeedEvent(type, resource, String(id), payload, now()))

  const vendorOf = async (id: SpoolRecordId | null) => {
    if (id === null) return null
    const found = await repo.vendors.get(id)
    return found.ok ? found.value : null
  }
  const renderFilament = async (filament: SpoolFilament) =>
    filamentJson(filament, await vendorOf(filament.vendorId))
  const renderSpool = async (spool: Spool) => {
    const filament = await repo.filaments.get(spool.filamentId)
    if (!filament.ok) return undefined
    return spoolJson(
      spool,
      filament.value,
      await vendorOf(filament.value.vendorId),
    )
  }
  /** Run a capture step; never let it affect the mutation it observes. */
  const safely = async (step: () => Promise<void>) => {
    try {
      await step()
    } catch {
      // The mutation already succeeded; its event is best effort.
    }
  }
  const settingChanged = (key: string) =>
    safely(async () => {
      const views = await settingViews(repo)
      const setting = views.ok ? views.value[key] : undefined
      if (!setting || !Object.hasOwn(SETTING_DEFINITIONS, key)) return
      events.push(
        buildFeedEvent('updated', 'setting', key, { key, setting }, now()),
      )
    })

  const spoolRows = async () => {
    const rows = await loadAll((page) => repo.spools.list(page))
    return rows.ok ? rows.value : []
  }

  return {
    get farmId() {
      return repo.farmId
    },
    get access() {
      return repo.access
    },
    locations: repo.locations,
    extraFields: {
      list: (entity) => repo.extraFields.list(entity),
      async upsert(definition) {
        const result = await repo.extraFields.upsert(definition)
        if (result.ok)
          await settingChanged(`extra_fields_${definition.entityType}`)
        return result
      },
      async delete(entity, key) {
        const result = await repo.extraFields.delete(entity, key)
        if (result.ok) await settingChanged(`extra_fields_${entity}`)
        return result
      },
    },
    settings: {
      list: () => repo.settings.list(),
      async set(key, value) {
        const result = await repo.settings.set(key, value)
        if (result.ok) await settingChanged(key)
        return result
      },
      async reset(key) {
        const result = await repo.settings.reset(key)
        if (result.ok) await settingChanged(key)
        return result
      },
    },
    async renameSpoolFieldValue(field, from, to) {
      let before: Spool[] = []
      await safely(async () => {
        before = await spoolRows()
      })
      const result = await repo.renameSpoolFieldValue(field, from, to)
      if (result.ok && result.value > 0)
        await safely(async () => {
          const after = new Map((await spoolRows()).map((s) => [s.id, s]))
          for (const old of before) {
            const next = after.get(old.id)
            if (!next || JSON.stringify(next) === JSON.stringify(old)) continue
            const payload = await renderSpool(next)
            if (payload) push('updated', 'spool', next.id, payload)
          }
        })
      return result
    },
    vendors: {
      list: (page) => repo.vendors.list(page),
      get: (id) => repo.vendors.get(id),
      async create(input) {
        const result = await repo.vendors.create(input)
        if (result.ok)
          push('added', 'vendor', result.value.id, vendorJson(result.value))
        return result
      },
      async update(id, patch) {
        const result = await repo.vendors.update(id, patch)
        if (result.ok) push('updated', 'vendor', id, vendorJson(result.value))
        return result
      },
      async delete(id) {
        let vendor: SpoolVendor | undefined
        let orphans: SpoolFilament[] = []
        await safely(async () => {
          const found = await repo.vendors.get(id)
          if (found.ok) vendor = found.value
          const all = await loadAll((page) => repo.filaments.list(page))
          if (all.ok) orphans = all.value.filter((f) => f.vendorId === id)
        })
        const result = await repo.vendors.delete(id)
        if (result.ok && vendor) {
          push('deleted', 'vendor', id, vendorJson(vendor))
          // Upstream clears the vendor of the filaments that referred to it.
          await safely(async () => {
            for (const orphan of orphans) {
              const current = await repo.filaments.get(orphan.id)
              if (current.ok)
                push(
                  'updated',
                  'filament',
                  orphan.id,
                  await renderFilament(current.value),
                )
            }
          })
        }
        return result
      },
    },
    filaments: {
      list: (page) => repo.filaments.list(page),
      get: (id) => repo.filaments.get(id),
      async create(input) {
        const result = await repo.filaments.create(input)
        if (result.ok)
          await safely(async () => {
            const payload = await renderFilament(result.value)
            push('added', 'filament', result.value.id, payload)
          })
        return result
      },
      async update(id, patch) {
        const result = await repo.filaments.update(id, patch)
        if (result.ok)
          await safely(async () => {
            const payload = await renderFilament(result.value)
            push('updated', 'filament', id, payload)
          })
        return result
      },
      async delete(id) {
        let payload: Record<string, unknown> | undefined
        await safely(async () => {
          const found = await repo.filaments.get(id)
          if (found.ok) payload = await renderFilament(found.value)
        })
        // A filament that spools still refer to is refused, so nothing cascades.
        const result = await repo.filaments.delete(id)
        if (result.ok && payload) push('deleted', 'filament', id, payload)
        return result
      },
    },
    spools: {
      list: (page) => repo.spools.list(page),
      get: (id) => repo.spools.get(id),
      async create(input) {
        const result = await repo.spools.create(input)
        if (result.ok)
          await safely(async () => {
            const payload = await renderSpool(result.value)
            if (payload) push('added', 'spool', result.value.id, payload)
          })
        return result
      },
      async update(id, patch) {
        const result = await repo.spools.update(id, patch)
        if (result.ok)
          await safely(async () => {
            const payload = await renderSpool(result.value)
            if (payload) push('updated', 'spool', id, payload)
          })
        return result
      },
      async use(id, grams) {
        const result = await repo.spools.use(id, grams)
        if (result.ok)
          await safely(async () => {
            const payload = await renderSpool(result.value)
            if (payload) push('updated', 'spool', id, payload)
          })
        return result
      },
      async delete(id) {
        let payload: Record<string, unknown> | undefined
        await safely(async () => {
          const found = await repo.spools.get(id)
          if (found.ok) payload = await renderSpool(found.value)
        })
        const result: Result<true> = await repo.spools.delete(id)
        if (result.ok && payload) push('deleted', 'spool', id, payload)
        return result
      },
    },
  }
}
