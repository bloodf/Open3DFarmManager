// SPDX-License-Identifier: MIT
import { createHash, type X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { connect, type ConnectionOptions } from 'node:tls'

export class PinMismatch extends Error {
  readonly code = 'ANYCUBIC_PIN_MISMATCH'

  constructor() {
    super('Anycubic broker certificate fingerprint mismatch')
    this.name = 'PinMismatch'
  }
}

export class AnycubicPairingRequired extends Error {
  readonly code = 'ANYCUBIC_PAIRING_REQUIRED'

  constructor(error: Error & { code?: string | number }) {
    const reason =
      error.code === 'CERT_HAS_EXPIRED' ? 'expired' : 'could not be verified'
    super(
      `Anycubic broker certificate ${reason}. Pair this printer to trust its pin.`,
      {
        cause: error,
      },
    )
    this.name = 'AnycubicPairingRequired'
  }
}

export function anycubicTlsTrustError(
  error: Error & { code?: string | number },
): PinMismatch | AnycubicPairingRequired | undefined {
  if (error instanceof PinMismatch) return error
  if (
    error.code === 'CERT_HAS_EXPIRED' ||
    error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    error.code === 'SELF_SIGNED_CERT_IN_CHAIN'
  )
    return new AnycubicPairingRequired(error)
}

export function normalizeAnycubicPin(value?: string): string | undefined {
  const pin = value?.replaceAll(':', '').toLowerCase()
  if (pin !== undefined && !/^[a-f0-9]{64}$/.test(pin))
    throw new Error('Invalid Kobra X certificate fingerprint')
  return pin
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function spkiPin(cert: X509Certificate): string {
  return sha256(cert.publicKey.export({ type: 'spki', format: 'der' }))
}

export function connectAnycubicTls(options: ConnectionOptions, pin?: string) {
  const socket = connect({ ...options, rejectUnauthorized: pin === undefined })
  if (pin === undefined) return socket

  // MQTT writes CONNECT as soon as its stream builder returns.
  socket.cork()
  socket.once('secureConnect', () => {
    try {
      const cert = socket.getPeerX509Certificate()
      if (cert && (sha256(cert.raw) === pin || spkiPin(cert) === pin)) {
        socket.uncork()
        return
      }
    } catch {
      // An unreadable public key cannot match a stored pin.
    }
    socket.destroy(new PinMismatch())
  })
  return socket
}

export async function captureAnycubicPeerPin(
  { host, port, servername, cert, key, secureContext }: ConnectionOptions,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  const socket = connect({
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(servername !== undefined ? { servername } : {}),
    ...(cert !== undefined ? { cert } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(secureContext !== undefined ? { secureContext } : {}),
    minVersion: 'TLSv1.2',
    rejectUnauthorized: false,
  })
  // An aborted capture can tear down the socket while TLS is still finishing.
  socket.on('error', () => {})
  try {
    await once(socket, 'secureConnect', {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    })
    const certificate = socket.getPeerX509Certificate()
    if (!certificate)
      throw new Error('Anycubic broker did not send a certificate')
    return spkiPin(certificate)
  } finally {
    socket.destroy()
  }
}
