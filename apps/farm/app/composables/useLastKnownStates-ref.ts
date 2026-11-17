import { shallowRef } from 'vue'

/**
 * A mutable reference for the farm view.
 *
 * The farm interface depends on Vue; the root workspace does not. This module
 * re-exports the reactive reference the view needs so the node tests can drive
 * the view state without importing Vue by path.
 */
export function farmRef<T>(value: T) {
  return shallowRef(value)
}

/**
 * Waits until the pending microtasks and the queued jobs of the event loop
 * have run. The view reacts on the next tick, not synchronously.
 *
 * A read over the network needs the event loop to turn more than once, so the
 * wait repeats until the view settles or the budget runs out.
 */
export async function settleFarmUpdates(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
