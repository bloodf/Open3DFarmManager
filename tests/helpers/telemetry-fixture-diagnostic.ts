import type { Readable } from 'node:stream'

/** Capture bounded synthetic fixture stderr, replacing any secret-bearing line. */
export function captureFixtureStderr(
  stream: Readable,
  secrets: readonly string[],
) {
  const max = 8192
  let raw = '',
    truncated = false
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    if (raw.length + chunk.length > max) truncated = true
    if (raw.length < max) raw += chunk.slice(0, max - raw.length)
  })
  const markers = secrets
    .flatMap((secret) => secret.split(/\r?\n/))
    .filter((value) => value.length >= 8)
    .map((value) => value.slice(0, 8))
  return () => {
    const text = raw
      .split(/\r?\n/)
      .map((line) =>
        markers.some((marker) => line.includes(marker)) ||
        line.includes('-----BEGIN ')
          ? '[redacted line]'
          : line.replace(
              /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
              '?',
            ),
      )
      .join('\n')
    return {
      text: text.slice(0, max),
      truncated: truncated || text.length > max,
    }
  }
}
