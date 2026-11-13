// SPDX-License-Identifier: MIT
// Fresh throwaway TLS identity for the synthetic fixture. Nothing here is, or
// is derived from, manufacturer or upstream certificate material.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SyntheticTls {
  key: Buffer
  cert: Buffer
}

/**
 * Generates a one-day self-signed certificate with the local `openssl` CLI.
 * The private key only exists in a private temporary directory that is removed
 * before this function returns, and in the returned buffer.
 */
export function createSyntheticTls(): SyntheticTls {
  const dir = mkdtempSync(join(tmpdir(), 'openfarm-synthetic-kobra-tls-'))
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=openfarm-synthetic-kobra.invalid',
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )
    return { key: readFileSync(key), cert: readFileSync(cert) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
