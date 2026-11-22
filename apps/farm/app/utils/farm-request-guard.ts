export function createFarmRequestGuard(currentFarm: () => string) {
  let generation = 0
  return {
    start(farmId: string) {
      const mine = ++generation
      return () => mine === generation && farmId === currentFarm()
    },
    invalidate() {
      generation++
    },
  }
}

export function selectedFarm<T extends { farmId: string }>(
  farms: T[],
  requested: unknown,
): T | undefined {
  return farms.find((farm) => farm.farmId === requested) ?? farms[0]
}
