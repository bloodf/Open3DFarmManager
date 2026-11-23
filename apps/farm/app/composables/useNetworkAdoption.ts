import type { NetworkAdoption } from '../utils/network-adoption.ts'

export function useNetworkAdoption() {
  return useState<NetworkAdoption | null>('network-adoption', () => null)
}
