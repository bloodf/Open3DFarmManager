import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

process.env.NITRO_SSL_CERT = readFileSync('/sandbox/tls.crt', 'utf8')
process.env.NITRO_SSL_KEY = readFileSync('/sandbox/tls.key', 'utf8')
await import(
  pathToFileURL(resolve('infra/sandbox/.output/server/index.mjs')).href
)
