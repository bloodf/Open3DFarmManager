const channelName = 'open3dfarmmanager:auth-invalidation'

export function notifyAuthInvalidation() {
  if (typeof window === 'undefined') return
  try {
    const channel = new BroadcastChannel(channelName)
    try {
      channel.postMessage(null)
    } finally {
      channel.close()
    }
  } catch {
    // Focus and visibility revalidation remain available.
  }
}

export function listenForAuthInvalidation(invalidate: () => void) {
  if (typeof window === 'undefined') return () => {}
  try {
    const channel = new BroadcastChannel(channelName)
    channel.onmessage = invalidate
    return () => channel.close()
  } catch {
    return () => {}
  }
}

export async function completeAuth(request: () => Promise<unknown>) {
  await request()
  notifyAuthInvalidation()
}
