import { describe, expect, it } from 'vitest'
import { credentialKeyring } from '../../apps/farm/server/utils/sealed-credential-key.ts'
import { sealClientSecret, openClientSecret } from '../../apps/farm/server/utils/sign-in-provider-secret.ts'
import { sealBambuCloudSecret, openBambuCloudSecret } from '../../apps/farm/server/utils/bambu-cloud/secret.ts'

const session = 's'.repeat(32)
const oldKey = 'o'.repeat(32)
const newKey = 'n'.repeat(32)

describe.each([
  ['provider', sealClientSecret, openClientSecret],
  ['bambu', sealBambuCloudSecret, openBambuCloudSecret],
])('%s credential keys', (_name, seal, open) => {
  it('survives session rotation and reads the previous key while writing with the current key', () => {
    const old = credentialKeyring({ sessionSecret: session, credentialEncryptionKey: oldKey })
    const rotated = credentialKeyring({ sessionSecret: 't'.repeat(32), credentialEncryptionKey: newKey, credentialEncryptionPreviousKey: oldKey })
    const previous = seal('token', old)
    expect(open(previous, rotated)).toBe('token')
    const current = seal('token', rotated)
    expect(open(current, rotated)).toBe('token')
    expect(() => open(current, old)).toThrow()
    expect(open(seal('token', old), credentialKeyring({ sessionSecret: 't'.repeat(32), credentialEncryptionKey: oldKey }))).toBe('token')
  })
  it('reads legacy values with the session key but refuses legacy-key writes', () => {
    const legacy = seal('token', session)
    const keys = credentialKeyring({ sessionSecret: session, credentialEncryptionKey: newKey })
    expect(open(legacy, keys)).toBe('token')
    expect(() => seal('token', credentialKeyring({ sessionSecret: session }))).toThrow()
  })
})
