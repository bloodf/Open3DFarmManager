// SPDX-License-Identifier: MIT
// Original minimal MQTT 3.1.1 framing helpers written from the public OASIS
// specification for the synthetic fixture. No third-party code.

export interface MqttPacket {
  header: number
  body: Buffer
}

export type MqttFrameError = 'oversize' | 'malformed'

export interface MqttFrames {
  packets: MqttPacket[]
  rest: Buffer
  error?: MqttFrameError
}

/** Length-prefixed UTF-8 string or binary field. */
export function mqttField(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  if (bytes.length > 0xffff) throw new RangeError('MQTT field too long')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(bytes.length)
  return Buffer.concat([length, bytes])
}

export function mqttPacket(
  header: number,
  body: Buffer = Buffer.alloc(0),
): Buffer {
  const length: number[] = []
  let remaining = body.length
  do {
    const digit = remaining % 128
    remaining = Math.floor(remaining / 128)
    length.push(remaining > 0 ? digit | 128 : digit)
  } while (remaining > 0)
  if (length.length > 4) throw new RangeError('MQTT packet too long')
  return Buffer.concat([Buffer.from([header, ...length]), body])
}

/** QoS 0 PUBLISH without retain or duplicate flags. */
export function mqttPublish(topic: string, payload: string | Buffer): Buffer {
  const bytes =
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  return mqttPacket(0x30, Buffer.concat([mqttField(topic), bytes]))
}

/**
 * Splits every complete packet off the front of a byte stream. An oversize or
 * malformed length is reported as soon as the length prefix is readable, so a
 * caller never has to buffer a body it is going to reject.
 */
export function takeMqttPackets(
  buffer: Buffer,
  maxRemainingLength: number,
): MqttFrames {
  const packets: MqttPacket[] = []
  let rest = buffer
  while (rest.length >= 2) {
    let length = 0
    let multiplier = 1
    let offset = 1
    let complete = false
    while (offset <= 4) {
      const digit = rest[offset]
      if (digit === undefined) return { packets, rest }
      offset += 1
      length += (digit & 127) * multiplier
      multiplier *= 128
      if ((digit & 128) === 0) {
        complete = true
        break
      }
    }
    if (!complete) return { packets, rest, error: 'malformed' }
    if (length > maxRemainingLength) {
      return { packets, rest, error: 'oversize' }
    }
    if (rest.length < offset + length) return { packets, rest }
    packets.push({
      header: rest[0] ?? 0,
      body: rest.subarray(offset, offset + length),
    })
    rest = rest.subarray(offset + length)
  }
  return { packets, rest }
}

/** Bounds-checked sequential reader over one packet body. */
export function mqttReader(body: Buffer) {
  let cursor = 0
  return {
    get remaining(): number {
      return body.length - cursor
    },
    byte(): number | undefined {
      const value = body[cursor]
      if (value !== undefined) cursor += 1
      return value
    },
    uint16(): number | undefined {
      if (cursor + 2 > body.length) return undefined
      const value = body.readUInt16BE(cursor)
      cursor += 2
      return value
    },
    field(): Buffer | undefined {
      const size = this.uint16()
      if (size === undefined || cursor + size > body.length) return undefined
      const value = body.subarray(cursor, cursor + size)
      cursor += size
      return value
    },
    rest(): Buffer {
      const value = body.subarray(cursor)
      cursor = body.length
      return value
    },
  }
}
