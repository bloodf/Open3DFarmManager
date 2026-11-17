import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pagesDirectory = join(root, 'apps/farm/app/pages')
const layoutPath = join(root, 'apps/farm/app/layouts/default.vue')
const explicitlyExcludedPages: string[] = []

test('every page has a main navigation destination or an explicit exclusion', async () => {
  const pageFiles = (await readdir(pagesDirectory))
    .filter((file) => file.endsWith('.vue'))
    .map((file) => (file === 'index.vue' ? '/' : `/${file.slice(0, -4)}`))
  const layout = await readFile(layoutPath, 'utf8')
  const destinations = [...layout.matchAll(/to: '(\/[^']*)'/g)].map(
    ([, destination]) => destination,
  )
  const missing = pageFiles.filter(
    (page) =>
      !destinations.includes(page) && !explicitlyExcludedPages.includes(page),
  )

  assert.deepEqual(
    missing,
    [],
    `Pages missing from navigation: ${missing.join(', ')}`,
  )
  assert.deepEqual(explicitlyExcludedPages, [])
})

test('navigation supports keyboard use and exposes its current page accessibly', async () => {
  const layout = await readFile(layoutPath, 'utf8')

  assert.match(layout, /<nav aria-label="Navegação principal">/)
  assert.match(layout, /<NuxtLink\s+v-for="link in links"/)
  assert.match(
    layout,
    /:aria-current="route\.path === link\.to \? 'page' : undefined"/,
  )
  assert.match(layout, /a:focus-visible\s*\{[^}]*outline:/s)
})

test('sign-in and sign-out reflect authentication, and invitations require owner role', async () => {
  const layout = await readFile(layoutPath, 'utf8')

  assert.match(layout, /\$fetch\('\/api\/auth\/me'/)
  assert.match(layout, /authenticated\.value\s*\?\s*\[\{ to: '\/sair'/)
  assert.match(layout, /:\s*\[\{ to: '\/entrar'/)
  assert.match(layout, /isOwner\.value\s*\?\s*\[\{ to: '\/convites'/)
})
