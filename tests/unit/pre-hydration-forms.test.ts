import { expect, it } from 'vitest'
import { asyncClientEntry } from '../../apps/farm/app/utils/pre-hydration'

it('loads the Nuxt module asynchronously without changing other scripts', () => {
  expect(
    asyncClientEntry(
      '<script type="module" src="/_nuxt/entry.js" crossorigin></script><script src="/other.js"></script>',
    ),
  ).toBe(
    '<script type="module" async src="/_nuxt/entry.js" crossorigin></script><script src="/other.js"></script>',
  )
})
