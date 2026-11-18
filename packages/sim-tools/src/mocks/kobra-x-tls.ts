// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThrowawayTlsMaterial, TlsKeyPair } from './tls.ts'

export interface KobraXTlsMaterial extends ThrowawayTlsMaterial {
  serverFingerprintSha256: string
  clientCommonName: string
}

export interface GenerateKobraXTlsOptions {
  days?: number | undefined
  clientCommonName?: string | undefined
  dirPrefix?: string | undefined
}

function readPair(keyPath: string, certPath: string): TlsKeyPair {
  return {
    keyPath,
    certPath,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  }
}

/**
 * Generates throwaway mutual-TLS material for Kobra X mocks:
 * - A self-signed server certificate (issuer === subject, SAN 127.0.0.1/localhost).
 * - A throwaway client CA and a signed test client certificate (default CN=AnycubicSlicer).
 * Written to a temporary directory and never committed.
 */
export function generateKobraXThrowawayTls(
  options: GenerateKobraXTlsOptions = {},
): KobraXTlsMaterial {
  const prefix = options.dirPrefix ?? 'openfarm-kobrax-tls-'
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const days = String(options.days ?? 1)
  const clientCommonName = options.clientCommonName ?? 'AnycubicSlicer'

  try {
    const serverKeyPath = join(dir, 'server.key')
    const serverCertPath = join(dir, 'server.crt')
    const caKeyPath = join(dir, 'client-ca.key')
    const caCertPath = join(dir, 'client-ca.crt')
    const clientKeyPath = join(dir, 'client.key')
    const clientCsrPath = join(dir, 'client.csr')
    const clientCertPath = join(dir, 'client.crt')

    // 1. Self-signed server certificate (matches real printer behavior)
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        serverKeyPath,
        '-out',
        serverCertPath,
        '-days',
        days,
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )

    // 2. Throwaway Client CA
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        caKeyPath,
        '-out',
        caCertPath,
        '-days',
        days,
        '-subj',
        '/CN=OpenFarm-KobraX-Mock-Client-CA',
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )

    // 3. Test Client Certificate signed by the Throwaway Client CA
    execFileSync(
      'openssl',
      [
        'req',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        clientKeyPath,
        '-out',
        clientCsrPath,
        '-subj',
        `/CN=${clientCommonName}`,
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )

    execFileSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        clientCsrPath,
        '-CA',
        caCertPath,
        '-CAkey',
        caKeyPath,
        '-CAcreateserial',
        '-out',
        clientCertPath,
        '-days',
        days,
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )

    const ca = readPair(caKeyPath, caCertPath)
    const server = readPair(serverKeyPath, serverCertPath)
    const client = readPair(clientKeyPath, clientCertPath)
    const serverFingerprintSha256 = createHash('sha256')
      .update(new X509Certificate(server.cert).raw)
      .digest('hex')

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }

    return {
      dir,
      ca,
      server,
      client,
      serverFingerprintSha256,
      clientCommonName,
      cleanup,
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

export function generateWrongKobraXClientCert(
  commonName = 'UntrustedClient',
): TlsKeyPair & { cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openfarm-kobrax-wrong-cert-'))
  try {
    const keyPath = join(dir, 'wrong-client.key')
    const certPath = join(dir, 'wrong-client.crt')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        `/CN=${commonName}`,
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )
    const pair = readPair(keyPath, certPath)
    let cleaned = false
    return {
      ...pair,
      cleanup() {
        if (cleaned) return
        cleaned = true
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      },
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

let cachedSharedKobraXTls: KobraXTlsMaterial | undefined

export function getSharedKobraXTls(): KobraXTlsMaterial {
  if (!cachedSharedKobraXTls) {
    cachedSharedKobraXTls = generateKobraXThrowawayTls()
    process.once('exit', () => {
      cachedSharedKobraXTls?.cleanup()
      cachedSharedKobraXTls = undefined
    })
  }
  return cachedSharedKobraXTls
}
