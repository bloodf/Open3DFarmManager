// Connector side of the built-server renewal run. Spawned with NODE_EXTRA_CA_CERTS
// so the real HTTPS transport trusts only the fixture's loopback certificate.
import {
  createRenewalHttpTransport,
  readOrRecoverRuntimeCredential,
  renewCredentialOnce,
} from '../../packages/connector/src/cloud/credential-renewal.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { loadExistingIdentity } from '../../packages/connector/src/identity/store.ts'

const input = JSON.parse(process.env.RENEWAL_HTTPS_CHILD ?? '') as {
  step: 'renew' | 'startup'
  credentialPath: string
  dataDirectory: string
  origin: string
  audience: string
}
const identity = loadExistingIdentity(input.dataDirectory)
const transport = createRenewalHttpTransport({
  origin: input.origin,
  timeoutMs: 10000,
})
const signal = AbortSignal.timeout(30000)
const print = (value: object) => console.log(JSON.stringify(value))
try {
  if (input.step === 'renew') {
    const outcome = await renewCredentialOnce({
      credentialPath: input.credentialPath,
      credential: readRuntimeCredential(
        input.credentialPath,
        identity.fingerprint,
        Date.now(),
      ),
      identity,
      transport,
      origin: input.origin,
      audience: input.audience,
      signal,
      now: Date.now,
    })
    print({ result: outcome.kind })
  } else {
    const diagnostics: string[] = []
    const credential = await readOrRecoverRuntimeCredential({
      credentialPath: input.credentialPath,
      identity,
      onDiagnostic: (d) => diagnostics.push(d.kind),
      recovery: {
        transport,
        origin: input.origin,
        audience: input.audience,
        signal,
        retryMs: 500,
      },
    })
    print({
      result: 'recovered',
      expiresAt: credential.expires_at,
      diagnostics,
    })
  }
} catch (error) {
  print({
    result: 'error',
    name: error instanceof Error ? error.constructor.name : 'unknown',
  })
}
