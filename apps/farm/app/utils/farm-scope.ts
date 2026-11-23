import type { LocationQueryRaw } from 'vue-router'

/** An explicit route scope must match a membership. Only an unscoped route
 * with exactly one membership has an implicit farm. Resolving never writes the URL. */
export function resolveFarmScope<T extends { farmId: string }>(
  farms: readonly T[],
  requested: unknown,
  hasMore = false,
): T | undefined {
  if (requested === undefined)
    return !hasMore && farms.length === 1 ? farms[0] : undefined
  return farms.find(({ farmId }) => farmId === requested)
}

export type FarmMembershipPage<T> = { farms: T[]; nextAfter?: string | null }

export async function readFarmMemberships<T>(
  readPage: (after?: string) => Promise<FarmMembershipPage<T>>,
): Promise<T[]> {
  const farms: T[] = []
  const cursors = new Set<string>()
  let after: string | undefined
  do {
    const page = await readPage(after)
    farms.push(...page.farms)
    after = page.nextAfter ?? undefined
    if (after && cursors.has(after)) throw new Error('Invalid farm cursor')
    if (after) cursors.add(after)
  } while (after)
  return farms
}

/** Preserve manual pagination until a scoped route needs a later membership. */
export async function readFarmSelectionPage<T extends { farmId: string }>(
  readPage: (after?: string) => Promise<FarmMembershipPage<T>>,
  requested: unknown,
  after?: string,
): Promise<FarmMembershipPage<T>> {
  const page = await readPage(after)
  if (
    after ||
    !page.nextAfter ||
    typeof requested !== 'string' ||
    resolveFarmScope(page.farms, requested)
  )
    return page
  return {
    farms: await readFarmMemberships((cursor) =>
      cursor ? readPage(cursor) : Promise.resolve(page),
    ),
    nextAfter: null,
  }
}

export function farmLocation(
  path: string,
  farmId: string | undefined,
  query: LocationQueryRaw = {},
) {
  return { path, query: { ...query, ...(farmId ? { farm: farmId } : {}) } }
}
