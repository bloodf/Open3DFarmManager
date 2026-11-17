/** Nitro's `raw:` import: the file's text, bundled at build time. */
declare module 'raw:*' {
  const source: string
  export default source
}
