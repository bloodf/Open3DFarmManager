import { randomUUID } from 'node:crypto'

/** Community reference: sections 3, 14 and 16.
 * https://github.com/rvanderp3/kobra-connect/blob/main/docs/mqtt-commands.md
 * Upload POST body and listing response schema are unspecified there. Do not
 * guess a multipart field or claim a normalized listing from that evidence.
 */
export const anycubicFileSupport = {
  upload: false,
  list: false,
  start: true,
} as const

export async function uploadAnycubicFile(): Promise<never> {
  throw new Error('Unsupported Anycubic upload: undocumented POST body')
}

export async function listAnycubicFiles(): Promise<never> {
  throw new Error('Unsupported Anycubic listing: undocumented response schema')
}

export interface AnycubicFileTransport {
  /** Connector-owned authenticated LAN MQTT session; resolves on acknowledgement. */
  publish(topic: string, payload: string, signal: AbortSignal): Promise<void>
}

export async function startAnycubicPrint(input: {
  transport: AnycubicFileTransport
  model: string
  deviceId: string
  filename: string
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  if (input.model !== '20024') throw new Error('Unsupported Anycubic model')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId))
    throw new Error('Invalid Anycubic device ID')
  if (
    input.filename.length > 255 ||
    !input.filename.endsWith('.gcode') ||
    /[\\\x00-\x1f\x7f%]/.test(input.filename) ||
    input.filename
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid Anycubic filename')
  await input.transport.publish(
    `anycubic/anycubicCloud/v1/slicer/printer/${input.model}/${input.deviceId}/print`,
    JSON.stringify({
      type: 'print',
      action: 'start',
      timestamp: Date.now(),
      msgid: randomUUID(),
      data: { taskid: '-1', filename: input.filename, filetype: 1 },
    }),
    input.signal,
  )
}
