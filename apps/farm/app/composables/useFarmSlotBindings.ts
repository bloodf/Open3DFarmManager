import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { loadSlotBindings } from '../utils/slot-bindings-load.ts'
import { slotBindingKey, type SlotBindingIndex } from '../utils/slot-spools.ts'

export function useFarmSlotBindings(
  farmId: () => string | undefined,
  hasLiveMaterials: () => boolean,
) {
  const mounted = ref(false)
  const index = shallowRef<SlotBindingIndex>(new Map())
  const scope = computed(() =>
    mounted.value && hasLiveMaterials() ? farmId() : undefined,
  )
  onMounted(() => {
    mounted.value = true
  })
  watch(scope, async (id, _previous, onCleanup) => {
    index.value = new Map()
    if (!id) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    const { signal } = controller
    try {
      const loaded = await loadSlotBindings(id, signal)
      if (!signal.aborted) index.value = loaded
    } catch {
      // Slot metadata is optional. Live telemetry remains visible independently.
    }
  })
  return (printerId: string, materials: PrinterState['materials']) => {
    const slots = index.value.get(printerId)
    if (!slots || !materials?.length) return undefined
    return Object.fromEntries(
      materials.map(({ slot }) => [slot, slots.get(slotBindingKey(slot))]),
    )
  }
}
