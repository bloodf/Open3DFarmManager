import {
  parseBoundedJson,
  TelemetryBatch,
} from '@open3dfarmmanager/farm-protocol'
import type { TelemetrySender } from './drain.ts'

/** Prototype HTTP mapping of the internal ingestion result; no credentials or scheduling. */
export function createTelemetryHttpSender(options: {
  endpoint: string
  timeoutMs: number
  allowLoopbackHttpForTests?: boolean
}): TelemetrySender {
  const url = new URL(options.endpoint)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        options.allowLoopbackHttpForTests === true &&
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname)
      )) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 60_000
  )
    throw new Error('Invalid telemetry transport configuration')
  const endpoint = url.href
  const timeoutMs = options.timeoutMs
  return async (body, callerSignal) => {
    const deadline = new AbortController()
    const signal = AbortSignal.any([callerSignal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      if (signal.aborted) throw new Error()
      TelemetryBatch.parse(
        parseBoundedJson(body, {
          maxBytes: 65536,
          maxDepth: 5,
          maxValues: 2000,
          maxStringChars: 128,
        }),
      )
      const response = await fetch(endpoint, {
        method: 'POST',
        body,
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
      })
      if (
        response.status !== 200 ||
        !/^application\/json(?:\s*;|\s*$)/i.test(
          response.headers.get('content-type') ?? '',
        ) ||
        !response.body
      )
        throw new Error()
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 8192))
        throw new Error()
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 8192) throw new Error()
        chunks.push(value)
      }
      if (signal.aborted) throw new Error()
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const decoded = parseBoundedJson(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        { maxBytes: 8192, maxDepth: 3, maxValues: 105, maxStringChars: 36 },
      )
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
        throw new Error()
      const result = decoded as Record<string, unknown>
      if (
        Object.keys(result).sort().join(',') !== 'acceptedEventIds,ok' ||
        result.ok !== true ||
        !Array.isArray(result.acceptedEventIds) ||
        result.acceptedEventIds.length < 1 ||
        result.acceptedEventIds.length > 100 ||
        result.acceptedEventIds.some(
          (id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id),
        )
      )
        throw new Error()
      return result.acceptedEventIds
    } catch {
      throw new Error('Telemetry transport failed')
    } finally {
      clearTimeout(timer)
      deadline.abort()
      reader?.releaseLock()
    }
  }
}
