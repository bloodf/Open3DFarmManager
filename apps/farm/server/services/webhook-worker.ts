import { sendWebhook } from './webhook-delivery.ts'
import type { PostgresWebhooks } from '../storage/webhook-postgres.ts'

export async function deliverNextWebhook(
  store: Pick<PostgresWebhooks, 'claim' | 'eligible' | 'finish'>,
  send = sendWebhook,
) {
  const delivery = await store.claim()
  if (!delivery) return false
  if (!(await store.eligible(delivery))) {
    await store.finish(delivery, 'dead')
    return true
  }
  const delivered = await send(delivery).catch(() => false)
  await store.finish(delivery, delivered ? 'delivered' : 'pending')
  return true
}
