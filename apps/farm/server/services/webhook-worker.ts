import { sendWebhook, type WebhookDelivery } from './webhook-delivery.ts'

interface WebhookQueue<Delivery extends WebhookDelivery> {
  claim(): Promise<Delivery | undefined>
  eligible(delivery: NoInfer<Delivery>): Promise<boolean>
  finish(
    delivery: NoInfer<Delivery>,
    outcome: 'delivered' | 'dead' | 'pending',
  ): Promise<void>
}

export async function deliverNextWebhook<Delivery extends WebhookDelivery>(
  store: WebhookQueue<Delivery>,
  send: (delivery: NoInfer<Delivery>) => Promise<boolean> = sendWebhook,
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
