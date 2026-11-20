import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const guide = await readFile(new URL('../../docs/SELF-HOSTING.md', import.meta.url), 'utf8')
const compose = await readFile(new URL('../../infra/app/docker-compose.yml', import.meta.url), 'utf8')
const envExample = await readFile(new URL('../../.env.example', import.meta.url), 'utf8')

test('first-install guide covers secure compose, proxy, bootstrap, and optional services', () => {
  for (const term of ['Docker Engine', 'loopback', 'WebSocket', 'TLS', 'NUXT_AUTH_BOOTSTRAP_TOKEN', 'NUXT_AUTH_SESSION_SECRET', '30 days', '365 days', 'disabled']) {
    assert.ok(guide.toLowerCase().includes(term.toLowerCase()), `guide must cover ${term}`)
  }
  assert.match(compose, /127\.0\.0\.1:\$\{O3DFM_APP_PORT/)
  assert.match(compose, /127\.0\.0\.1:\$\{O3DFM_DB_PORT/)
})

test('guide points readers to the complete optional environment inventory', () => {
  assert.match(guide, /\.env\.example/)
  assert.match(envExample, /NUXT_AUTH_ENABLED=false/)
  assert.match(envExample, /NUXT_CONNECTOR_PAIRING_ENABLED=false/)
})
