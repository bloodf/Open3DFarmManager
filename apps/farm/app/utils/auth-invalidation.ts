const channelName = 'open3dfarmmanager:auth-invalidation'
const eventName = 'open3dfarmmanager:auth-invalidated'

function closeChannel(channel: BroadcastChannel) {
  try {
    channel.close()
  } catch {
    // Browser teardown must not turn a successful auth request into a failure.
  }
}

export function notifyAuthInvalidation() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(eventName))
  try {
    const channel = new BroadcastChannel(channelName)
    try {
      channel.postMessage(null)
    } finally {
      closeChannel(channel)
    }
  } catch {
    // Focus and visibility revalidation remain available.
  }
}

export function listenForAuthInvalidation(invalidate: () => void) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(eventName, invalidate)
  let channel: BroadcastChannel | undefined
  try {
    channel = new BroadcastChannel(channelName)
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === null) invalidate()
    }
  } catch {
    // Same-window events and focus revalidation remain available.
  }
  return () => {
    window.removeEventListener(eventName, invalidate)
    if (channel) {
      channel.onmessage = null
      closeChannel(channel)
      channel = undefined
    }
  }
}

export async function completeAuth(request: () => Promise<unknown>) {
  await request()
  notifyAuthInvalidation()
}
