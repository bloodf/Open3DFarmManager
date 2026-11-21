import { ref, watch } from 'vue'

export interface FarmSummary {
  farmId: string
}

export function useSpoolLibraryFarm() {
  const route = useRoute()
  const router = useRouter()

  const farms = ref<FarmSummary[]>([])
  const farmId = ref('')
  const loadingFarm = ref(true)
  const farmLoadError = ref('')
  const signInRequired = ref(false)
  const noFarm = ref(false)

  function requestedFarm(): string {
    const raw = route.query.farm
    return typeof raw === 'string' ? raw : ''
  }

  async function loadFarms() {
    loadingFarm.value = true
    farmLoadError.value = ''
    signInRequired.value = false
    noFarm.value = false
    try {
      const page = await $fetch<{ farms: FarmSummary[] }>('/api/farms', {
        query: { limit: 50 },
        retry: 0,
        timeout: 15_000,
      })
      farms.value = page.farms
      const preferred = requestedFarm()
      const matched = page.farms.find((farm) => farm.farmId === preferred)
      farmId.value = matched?.farmId ?? page.farms[0]?.farmId ?? ''
      if (!farmId.value) noFarm.value = true
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
    if (!nextFarmId || nextFarmId === farmId.value) return
    farmId.value = nextFarmId
    void router.replace({ query: { ...route.query, farm: nextFarmId } })
  }

  watch(
    () => route.query.farm,
    (next) => {
      if (typeof next !== 'string' || !next) return
      if (farms.value.some((farm) => farm.farmId === next)) {
        farmId.value = next
      }
    },
  )

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
