// Synthetic loopback TLS front for the built app: the auth cookie is Secure/__Host- and POST needs an exact HTTPS Origin.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pairingHttpProxy } from './pairing-http-proxy.ts'

const listen = Number(process.env.AUTH_E2E_TLS_PORT)
const upstream = Number(process.env.AUTH_E2E_APP_PORT)
if (!Number.isInteger(listen) || !Number.isInteger(upstream))
  throw new Error('AUTH_E2E_TLS_PORT and AUTH_E2E_APP_PORT required')
const directory = mkdtempSync(join(tmpdir(), 'o3dfm-auth-e2e-tls-'))
execFileSync(
  'openssl',
  [
    ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'],
    ...['-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    ...[
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'c.pem'),
    ],
  ],
  { stdio: 'ignore', timeout: 15_000 },
)
const server = pairingHttpProxy({
  key: readFileSync(join(directory, 'key.pem')),
  cert: readFileSync(join(directory, 'c.pem')),
  upstreamPort: () => upstream,
  // Fault injection is unused here; a random control value can never match.
  dropControl: randomBytes(16).toString('hex'),
})
const stop = () => {
  server.close()
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
server.listen(listen, '127.0.0.1')
