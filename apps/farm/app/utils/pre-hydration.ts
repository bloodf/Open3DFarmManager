/** Let the SSR page become usable while the client entry is still loading. */
export function asyncClientEntry(head: string): string {
  return head.replace(
    /<script type="module" src="(\/_nuxt\/[^" ]+\.js)"/g,
    '<script type="module" async src="$1"',
  )
}
