import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import {
  BUNDLED_KOBRA_CLIENT_CERT_PEM,
  BUNDLED_KOBRA_CLIENT_KEY_PEM,
  bundledKobraClientIdentity,
} from '../../packages/connector/src/config/kobra-x-default-cert'
import { resolveKobraClientIdentity } from '../../packages/connector/src/config/kobra-x-cert'

describe('bundled Kobra X client identity', () => {
  it('is the Anycubic Slicer certificate with a private key', () => {
    const cert = new X509Certificate(BUNDLED_KOBRA_CLIENT_CERT_PEM)
    expect(cert.subject).toContain('CN=AnycubicSlicer')
    expect(cert.subject).toContain('O=Anycubic')
    expect(BUNDLED_KOBRA_CLIENT_KEY_PEM).toMatch(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    )
    // The bundled key matches the bundled certificate.
    expect(
      cert.checkPrivateKey(
        createPrivateKey(bundledKobraClientIdentity().keyPem),
      ),
    ).toBe(true)
  })

  it('defaults to the bundled identity when no override is present', async () => {
    const resolved = await resolveKobraClientIdentity({
      // A directory with no certificate, so the install scan finds nothing.
      installPath: mkdtempSync(join(tmpdir(), 'kobra-empty-')),
    })
    expect(resolved.source).toBe('bundled')
    expect(resolved.certPem).toBe(BUNDLED_KOBRA_CLIENT_CERT_PEM)
    expect(resolved.keyPem).toBe(BUNDLED_KOBRA_CLIENT_KEY_PEM)
  })

  it('an explicit certificate file overrides the bundled default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kobra-override-'))
    try {
      const certPath = join(dir, 'client.pem')
      const keyPath = join(dir, 'client.key')
      writeFileSync(certPath, BUNDLED_KOBRA_CLIENT_CERT_PEM)
      writeFileSync(keyPath, 'OVERRIDE-KEY-CONTENT\n')
      const resolved = await resolveKobraClientIdentity({
        certFile: certPath,
        keyFile: keyPath,
      })
      expect(resolved.source).toBe('file')
      expect(resolved.certPem).toContain('BEGIN CERTIFICATE')
      expect(resolved.keyPem).toBe('OVERRIDE-KEY-CONTENT\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
