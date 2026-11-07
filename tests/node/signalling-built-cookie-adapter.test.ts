import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { useSession } from '../../apps/farm/node_modules/nuxt/dist/server/index.js'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'

// Recreate the exact Nuxt Nitro alias: its getCookie delegates to the H3 selected
// by the installed Nitro server, while useSession remains Nuxt's portable adapter.
const nuxtRequire = createRequire(
  realpathSync(
    new URL('../../apps/farm/node_modules/nuxt/package.json', import.meta.url),
  ),
)
const nitroRequire = createRequire(nuxtRequire.resolve('@nuxt/nitro-server'))
const h3Url = pathToFileURL(nitroRequire.resolve('h3')).href
const nuxtServerUrl = pathToFileURL(nuxtRequire.resolve('nuxt/server')).href
const adapter = `export * from ${JSON.stringify(nuxtServerUrl)}; export { getCookie } from ${JSON.stringify(h3Url)};`
const adapterUrl = `data:text/javascript,${encodeURIComponent(adapter)}`
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === 'nuxt/server' &&
      context.parentURL?.endsWith(
        '/apps/farm/server/services/authenticated-session.ts',
      )
    )
      return { url: adapterUrl, shortCircuit: true }
    return next(specifier, context)
  },
})
const { sealedSessionRecordId } =
  await import('../../apps/farm/server/services/authenticated-session.ts')
const config = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-test-password-with-at-least-32-characters',
  maxAge: 28800,
  cookie: { ...SESSION_COOKIE_ATTRIBUTES },
}
const portable = (cookie?: string) => ({
  req: new Request('https://farm.example/', {
    headers: cookie === undefined ? {} : { cookie },
  }),
  res: { headers: new Headers() },
})

test('Nitro-selected H3 getCookie cannot read portable events', async () => {
  const h3 = await import(h3Url)
  assert.throws(
    () =>
      h3.getCookie(
        portable(`${SESSION_COOKIE_NAME}=synthetic`),
        SESSION_COOKIE_NAME,
      ),
    TypeError,
  )
})

test('portable sealed sessions survive the Nitro cookie alias and invalid cookies deny', async () => {
  const issuing = portable()
  const session = await useSession(issuing, config)
  await session.update({ sessionRecordId: 'synthetic_session' })
  const sealed = issuing.res.headers.getSetCookie()[0]?.split(';')[0]
  assert.ok(sealed)
  assert.equal(
    await sealedSessionRecordId(portable(sealed), { cookie: config }),
    'synthetic_session',
  )
  for (const value of [
    undefined,
    'wrong=synthetic',
    `${SESSION_COOKIE_NAME}=`,
    `${SESSION_COOKIE_NAME}=invalid`,
  ])
    await assert.rejects(
      sealedSessionRecordId(portable(value), { cookie: config }),
    )
})
