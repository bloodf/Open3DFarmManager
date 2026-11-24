// SPDX-License-Identifier: MIT
import { createHash, type X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { Duplex } from 'node:stream'
import { connect as netConnect } from 'node:net'
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

function pinMatches(socket: ReturnType<typeof connect>, pin: string) {
  try {
    const cert = socket.getPeerX509Certificate()
    return !!cert && (sha256(cert.raw) === pin || spkiPin(cert) === pin)
  } catch {
    // An unreadable public key cannot match a stored pin.
    return false
  }
}

/**
 * Carries a TLS client's bytes to the network, but holds the client's second
 * flight (its certificate and Finished) until `release()`. Node reports the
 * server certificate to JavaScript only after the handshake, by which time
 * OpenSSL has already written the client certificate. With the flight held
 * here, a peer that fails verification never receives the client identity.
 */
class ClientFlightHold extends Duplex {
  readonly #raw: ReturnType<typeof netConnect>
  #inbound = false
  #held: { chunk: Buffer; done: (error?: Error | null) => void }[] = []
  #open = false

  constructor(options: { host: string; port: number }) {
    super()
    this.#raw = netConnect(options)
    this.#raw.on('data', (chunk) => {
      // The ClientHello is the only write before the server speaks.
      this.#inbound = true
      if (!this.push(chunk)) this.#raw.pause()
    })
    this.#raw.on('end', () => this.push(null))
    this.#raw.on('error', (error) => this.destroy(error))
    this.#raw.on('close', () => this.destroy())
  }

  override _read() {
    this.#raw.resume()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ) {
    if (this.#inbound && !this.#open) this.#held.push({ chunk, done })
    else this.#raw.write(chunk, done)
  }

  override _final(done: (error?: Error | null) => void) {
    this.#raw.end(done)
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    // Held bytes are dropped: they never left this process.
    this.#held = []
    this.#raw.destroy()
    done(error)
  }

  release() {
    this.#open = true
    for (const { chunk, done } of this.#held.splice(0))
      this.#raw.write(chunk, done)
  }
}

/**
 * Anycubic's TLS client.
 *
 * Trust modes:
 * - no pin: normal verification (`ca`, or the system store).
 * - pin only: the printer's self-signed certificate is accepted when its exact
 *   key (SPKI SHA-256) or leaf certificate (SHA-256) equals the pin. Dates do
 *   not matter.
 * - `ca` and pin: BOTH. The chain must verify against `ca`, and the peer must
 *   also match the pin. Either failing refuses the connection.
 *
 * `holdClientIdentity` also keeps the client certificate from reaching a peer
 * that has not passed those checks. It needs TLS 1.3, where the client's
 * certificate travels in its last flight. The caller's `secureContext` or
 * `minVersion` must allow nothing older, or the handshake cannot complete.
 * Without it, only application data waits for the check.
 */
export function connectAnycubicTls(
  options: ConnectionOptions,
  pin?: string,
  { holdClientIdentity = false }: { holdClientIdentity?: boolean } = {},
) {
  const verifyChain = pin === undefined || options.ca !== undefined
  const hold =
    holdClientIdentity &&
    typeof options.host === 'string' &&
    typeof options.port === 'number'
      ? new ClientFlightHold({ host: options.host, port: options.port })
      : undefined
  const socket = connect({
    ...options,
    ...(hold ? { socket: hold } : {}),
    rejectUnauthorized: verifyChain,
  })
  if (pin === undefined && !hold) return socket

  // MQTT writes CONNECT as soon as its stream builder returns.
  socket.cork()
  socket.once('secureConnect', () => {
    if (pin === undefined || pinMatches(socket, pin)) {
      hold?.release()
      socket.uncork()
      return
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
