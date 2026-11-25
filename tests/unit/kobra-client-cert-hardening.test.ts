import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { validateKobraClientCertificate } from '../../packages/shared/src/kobra-client-cert.ts'

const cert = readFileSync('tests/fixtures/bambu-ftps/cert.pem', 'utf8')
const key = readFileSync('tests/fixtures/bambu-ftps/key.pem', 'utf8')

function der(tag: number, value: number[] | Uint8Array): number[] {
  const bytes = [...value]
  if (bytes.length >= 128) throw new Error('fixture DER length too large')
  return [tag, bytes.length, ...bytes]
}

const digestInfo = der(
  0x30,
  der(
    0x30,
    der(0x06, [0x2b, 0x0e, 0x03, 0x02, 0x1a]).concat(der(0x05, [])),
  ).concat(der(0x04, Array(20).fill(0))),
)
const macData = der(
  0x30,
  digestInfo.concat(der(0x04, [1]), der(0x02, [0x4c, 0x4b, 0x41])),
)
const authSafe = der(
  0x30,
  der(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]).concat(
    der(0xa0, der(0x04, der(0x30, []))),
  ),
)
const oversizedMacIterationsPfx = Uint8Array.from(
  der(0x30, der(0x02, [3]).concat(authSafe, macData)),
)

describe('client certificate parser hardening', () => {
  it('rejects a private key without a public point', async () => {
    // PKCS#8 with a supported algorithm but no parsed public point.
    const result = await validateKobraClientCertificate({ text: cert + key })
    expect(result.ok).toBe(false)
  })

  it('rejects a structurally valid PKCS#12 with an oversized MAC iteration count', async () => {
    const digest = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValue(new Error('iteration work should not begin'))
    let result:
      Awaited<ReturnType<typeof validateKobraClientCertificate>> | undefined
    try {
      result = await validateKobraClientCertificate({
        bytes: oversizedMacIterationsPfx,
      })
      expect(digest).not.toHaveBeenCalled()
    } finally {
      digest.mockRestore()
    }
    if (!result) throw new Error('certificate validation did not finish')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected invalid PKCS#12 result')
    expect(result).toMatchObject({ reason: 'unreadable' })
  })
})
