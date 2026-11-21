/**
 * `GET /api/v1/{material,article-number,lot-number}` and `GET /api/v1/tag/reader`
 * of the pinned Spoolman v0.27.1: distinct values read off this farm's records.
 */
import { distinct } from './aux-common.ts'
import { loadAll } from './records.ts'
import { methodNotAllowed, respond, type LegacyApiModule } from './types.ts'

export const listsModule: LegacyApiModule = {
  name: 'lists',
  async handle(repo, request) {
    const path = request.apiPath
    if (
      path !== '/api/v1/material' &&
      path !== '/api/v1/article-number' &&
      path !== '/api/v1/lot-number' &&
      path !== '/api/v1/tag/reader'
    )
      return undefined
    if (request.method !== 'GET') return methodNotAllowed()
    // The reader registry upstream is in memory and empty until a reader
    // scans; no tag scan is accepted here, so it is always empty.
    if (path === '/api/v1/tag/reader') return respond(200, [])
    if (path === '/api/v1/lot-number') {
      const spools = await loadAll((page) => repo.spools.list(page))
      return spools.ok
        ? respond(200, distinct(spools.value.map((s) => s.lotNr)))
        : spools
    }
    const filaments = await loadAll((page) => repo.filaments.list(page))
    if (!filaments.ok) return filaments
    return respond(
      200,
      distinct(
        filaments.value.map((f) =>
          path === '/api/v1/material' ? f.material : f.articleNumber,
        ),
      ),
    )
  },
}
