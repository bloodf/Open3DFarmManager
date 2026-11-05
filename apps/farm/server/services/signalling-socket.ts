import type { IncomingMessage } from 'node:http'
import {
  installSignallingControlBounds,
  signallingNodeUpgrade,
} from './signalling-websocket-boundary.ts'
import type { SignallingSocketPort } from './signalling-websocket-limits.ts'
function object(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
export function destroySignallingUpgrade(input: unknown): void {
  try {
    signallingNodeUpgrade(input).socket.destroy()
  } catch {
    /* No compatible raw socket is available. */
  }
}
/** Pinned native Node adapter only. Binary rejection runs before CrossWS adds its
 * application message listener; it never decodes or queues an arbitrary payload. */
export function signallingNativeSocket(
  input: unknown,
  onBinary: () => void,
): {
  request: IncomingMessage
  port: SignallingSocketPort
} {
  installSignallingControlBounds(input)
  if (
    !object(input) ||
    !('request' in input) ||
    !('send' in input) ||
    typeof input.send !== 'function' ||
    !('terminate' in input) ||
    typeof input.terminate !== 'function' ||
    !('_internal' in input) ||
    !object(input._internal) ||
    !('ws' in input._internal) ||
    !object(input._internal.ws)
  )
    throw new Error('Unsupported signalling native socket')
  const native = input._internal.ws
  if (
    !('on' in native) ||
    typeof native.on !== 'function' ||
    !('bufferedAmount' in native)
  )
    throw new Error('Unsupported signalling native buffering')
  native.on('message', (_data: unknown, binary: unknown) => {
    if (binary !== false) onBinary()
  })
  const send = input.send.bind(input),
    terminate = input.terminate.bind(input)
  return {
    request: signallingNodeUpgrade(input.request),
    port: {
      bufferedAmount: () =>
        typeof native.bufferedAmount === 'number'
          ? native.bufferedAmount
          : Number.NaN,
      send: (text) => {
        send(text, { compress: false })
      },
      terminate: () => {
        terminate()
      },
    },
  }
}
export function signallingMessageText(input: unknown): string {
  if (!object(input) || !('rawData' in input))
    throw new Error('Unsupported signalling message')
  const raw = input.rawData
  if (typeof raw === 'string') {
    if (raw.length > 12288 || Buffer.byteLength(raw) > 12288)
      throw new Error('Frame too large')
    return raw
  }
  if (!(raw instanceof Uint8Array) || raw.byteLength > 12288)
    throw new Error('Invalid signalling frame')
  return new TextDecoder('utf-8', { fatal: true }).decode(raw)
}
