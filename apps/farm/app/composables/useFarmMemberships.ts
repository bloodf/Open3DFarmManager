import {
  readFarmMemberships,
  readFarmSelectionPage,
  type FarmMembershipPage,
} from '../utils/farm-scope.ts'

type Options = { signal?: AbortSignal; timeout?: number; cache?: RequestCache }

function fetchFarmPage<T>(options: Options, after?: string) {
  return $fetch<FarmMembershipPage<T>>('/api/farms', {
    query: { limit: 20, ...(after ? { after } : {}) },
    retry: 0,
    timeout: 10_000,
    ...options,
  })
}

export function fetchFarmMemberships<T = { farmId: string }>(
  options: Options = {},
) {
  return readFarmMemberships((after) => fetchFarmPage<T>(options, after))
}

export function fetchFarmSelectionPage(
  requested: unknown,
  options: Options = {},
  after?: string,
) {
  return readFarmSelectionPage(
    (cursor) => fetchFarmPage<{ farmId: string }>(options, cursor),
    requested,
    after,
  )
}
