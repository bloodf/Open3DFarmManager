import { asyncClientEntry } from '../../app/utils/pre-hydration.ts'

const accountPaths = new Set([
  '/entrar',
  '/criar-conta',
  '/primeiro-acesso',
  '/redefinir-senha',
])

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('render:html', (html, { event }) => {
    if (accountPaths.has(event.path.split('?')[0] ?? '')) {
      html.head = html.head.map(asyncClientEntry)
    }
  })
})
