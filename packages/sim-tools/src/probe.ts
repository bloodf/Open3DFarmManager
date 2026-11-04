import { Effect } from 'effect'
import { z } from 'zod'

const ServerInfo = z.object({
  result: z.object({
    klippy_connected: z.literal(true),
    klippy_state: z.literal('ready'),
  }),
})
export function simulatorUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Simulator probes require a loopback HTTP origin')
  }
  return url
}
export function probePrinter(origin: string) {
  return Effect.tryPromise({
    try: async () => {
      const url = new URL('/server/info', simulatorUrl(origin))
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      })
      if (!response.ok)
        throw new Error(`Simulator returned HTTP ${response.status}`)
      return ServerInfo.parse(await response.json()).result
    },
    catch: (error) =>
      error instanceof Error ? error : new Error('Simulator probe failed'),
  })
}
