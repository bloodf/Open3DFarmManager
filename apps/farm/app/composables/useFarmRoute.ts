import { computed, type Ref } from 'vue'
import { farmLocation, resolveFarmScope } from '../utils/farm-scope.ts'

export function useFarmRoute() {
  const route = useRoute()
  const router = useRouter()
  function setFarmScope(id: string) {
    return router.replace({
      ...farmLocation(route.path, id, { ...route.query, farm: id || null }),
      hash: route.hash,
    })
  }
  return { route, setFarmScope }
}

export function useFarmSelection<T extends { farmId: string }>(
  farms: Ref<T[]>,
) {
  const { route, setFarmScope } = useFarmRoute()
  return computed({
    get: () => resolveFarmScope(farms.value, route.query.farm)?.farmId ?? '',
    set: (id) => {
      void setFarmScope(id)
    },
  })
}
