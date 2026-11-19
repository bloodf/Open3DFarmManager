import { PrinterGcodePath } from '../../../farm-protocol/src/control-actions.ts'
import {
  moonrakerAuthHeaders,
  moonrakerSession,
  type MoonrakerLimits,
} from '../config/moonraker.ts'

export function moonrakerQueryClient(
  origin: string,
  limits: MoonrakerLimits,
  signal?: AbortSignal,
) {
  return {
    async request(
      method: string,
      params?: object,
      requestSignal?: AbortSignal,
    ): Promise<unknown> {
      const directory = params && 'path' in params ? params.path : undefined
      const validDirectory =
        directory === 'gcodes' ||
        (typeof directory === 'string' &&
          directory.startsWith('gcodes/') &&
          PrinterGcodePath.safeParse(directory.slice('gcodes/'.length)).success)
      const path =
        method === 'server.files.list'
          ? '/server/files/list?root=gcodes'
          : method === 'printer.objects.list'
            ? '/printer/objects/list'
            : method === 'server.files.get_directory' && validDirectory
              ? '/server/files/directory?' +
                new URLSearchParams({ path: String(directory) })
              : undefined
      if (!path) throw Error('Unsupported Moonraker query')
      const deadline = AbortSignal.any([
        ...(signal ? [signal] : []),
        ...(requestSignal ? [requestSignal] : []),
        AbortSignal.timeout(limits.requestTimeoutMs),
      ])
      deadline.throwIfAborted()
      const response = await fetch(new URL(path, origin), {
        signal: deadline,
        redirect: 'error',
        credentials: 'omit',
        headers: await (moonrakerSession(origin, limits)?.getAuthHeaders() ??
          moonrakerAuthHeaders(origin, limits)),
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw Error('Moonraker query unavailable')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > limits.maxMessageBytes)
            throw Error('Moonraker query too large')
          chunks.push(value)
        }
        const body: { result?: unknown } = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        )
        return body.result
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    },
  }
}
