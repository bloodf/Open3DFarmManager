// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TlsKeyPair {
  keyPath: string
  certPath: string
  key: Buffer
  cert: Buffer
}

export interface ThrowawayTlsMaterial {
  dir: string
  ca: TlsKeyPair
  server: TlsKeyPair
  client: TlsKeyPair
  cleanup(): void
}

export interface GenerateTlsOptions {
  days?: number
  commonName?: string
  dirPrefix?: string
}

/**
 * Generates fresh throwaway TLS material (CA, server and client certificates)
 * written to a secure temporary directory, never committed.
 */
export function generateThrowawayTls(
  options: GenerateTlsOptions = {},
): ThrowawayTlsMaterial {
  const prefix = options.dirPrefix ?? 'openfarm-mock-tls-'
  const dir = mkdtempSync(join(tmpdir(), prefix))

  try {
    const days = String(options.days ?? 1)
    const cn = options.commonName ?? '127.0.0.1'

    const caKeyPath = join(dir, 'ca.key')
    const caCertPath = join(dir, 'ca.crt')
    const serverKeyPath = join(dir, 'server.key')
    const serverCsrPath = join(dir, 'server.csr')
    const serverCertPath = join(dir, 'server.crt')
    const clientKeyPath = join(dir, 'client.key')
    const clientCsrPath = join(dir, 'client.csr')
    const clientCertPath = join(dir, 'client.crt')

    // 1. Root CA
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
        '/CN=OpenFarm-Throwaway-Mock-CA',
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )

    // 2. Server Key + CSR + Signed Certificate with SAN
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
        serverKeyPath,
        '-out',
        serverCsrPath,
        '-subj',
        `/CN=${cn}`,
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )

    execFileSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        serverCsrPath,
        '-CA',
        caCertPath,
        '-CAkey',
        caKeyPath,
        '-CAcreateserial',
        '-out',
        serverCertPath,
        '-days',
        days,
        '-copy_extensions',
        'copy',
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )

    // 3. Client Key + CSR + Signed Certificate
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
        '/CN=openfarm-mock-client',
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

    const ca = {
      keyPath: caKeyPath,
      certPath: caCertPath,
      key: readFileSync(caKeyPath),
      cert: readFileSync(caCertPath),
    }

    const server = {
      keyPath: serverKeyPath,
      certPath: serverCertPath,
      key: readFileSync(serverKeyPath),
      cert: readFileSync(serverCertPath),
    }

    const client = {
      keyPath: clientKeyPath,
      certPath: clientCertPath,
      key: readFileSync(clientKeyPath),
      cert: readFileSync(clientCertPath),
    }

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore errors during cleanup
      }
    }

    return {
      dir,
      ca,
      server,
      client,
      cleanup,
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

let cachedSharedTls: ThrowawayTlsMaterial | undefined

/**
 * Returns a process-shared throwaway TLS material instance for high-throughput
 * micro-benchmarks or loops (e.g. 100 primitive start/close tests).
 */
export function getSharedThrowawayTls(): ThrowawayTlsMaterial {
  if (!cachedSharedTls) {
    cachedSharedTls = generateThrowawayTls()
    process.once('exit', () => {
      cachedSharedTls?.cleanup()
      cachedSharedTls = undefined
    })
  }
  return cachedSharedTls
}
