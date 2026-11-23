import { computed, ref } from 'vue'
import { fetchFarmMemberships } from './useFarmMemberships.ts'
import { farmLocation, resolveFarmScope } from '../utils/farm-scope.ts'

export interface FarmSummary {
  farmId: string
}

export function useSpoolLibraryFarm() {
  const route = useRoute()
  const router = useRouter()

  const farms = ref<FarmSummary[]>([])
  const farmId = computed(
    () => resolveFarmScope(farms.value, route.query.farm)?.farmId ?? '',
  )
  const loadingFarm = ref(true)
  const farmLoadError = ref('')
  const signInRequired = ref(false)
  const noFarm = computed(() => !farmId.value)

  async function loadFarms() {
    loadingFarm.value = true
    farmLoadError.value = ''
    signInRequired.value = false
    try {
      farms.value = await fetchFarmMemberships({ timeout: 15_000 })
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'statusCode' in cause
          ? (cause as { statusCode?: unknown }).statusCode
          : undefined
      signInRequired.value = code === 401
      farmLoadError.value =
        code === 401
          ? 'Entre na sua conta para acessar a biblioteca de bobinas.'
          : 'Não foi possível carregar as farms disponíveis. Tente novamente.'
    } finally {
      loadingFarm.value = false
    }
  }

  function selectFarm(nextFarmId: string) {
    if (!farms.value.some((farm) => farm.farmId === nextFarmId)) return
    if (nextFarmId === route.query.farm) return
    void router.replace({
      ...farmLocation(route.path, nextFarmId, route.query),
      hash: route.hash,
    })
  }

  return {
    farms,
    farmId,
    loadingFarm,
    farmLoadError,
    signInRequired,
    noFarm,
    loadFarms,
    selectFarm,
  }
}
