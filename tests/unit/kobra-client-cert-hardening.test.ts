import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateKobraClientCertificate } from '../../packages/farm-protocol/src/kobra-client-cert.ts'

const cert = readFileSync('tests/fixtures/bambu-ftps/cert.pem', 'utf8')
const key = readFileSync('tests/fixtures/bambu-ftps/key.pem', 'utf8')

describe('client certificate parser hardening', () => {
  it('rejects a private key without a public point', async () => {
    // PKCS#8 with a supported algorithm but no parsed public point.
    const result = await validateKobraClientCertificate({ text: cert + key })
    expect(result.ok).toBe(false)
  })

  it('rejects malformed PKCS#12 data with an oversized iteration count', async () => {
    const result = await validateKobraClientCertificate({
      bytes: Uint8Array.from([0x30, 0x06, 0x02, 0x04, 0x01, 0x00, 0x00, 0x00]),
    })
    expect(result.ok).toBe(false)
  })
})
