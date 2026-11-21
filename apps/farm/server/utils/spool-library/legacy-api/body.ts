import type { LegacyBody } from './types.ts'

/**
 * FastAPI's body handling: an empty body is missing; JSON is parsed when the
 * content type is absent, `application/json` or `application/*+json`;
 * anything else reaches validation as raw text.
 */
export function classifyLegacyBody(
  raw: string | undefined,
  contentType: string | undefined,
): LegacyBody {
  if (!raw) return { kind: 'none' }
  const mime = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase()
  const json =
    mime === '' ||
    (mime.startsWith('application/') &&
      (mime === 'application/json' || mime.endsWith('+json')))
  if (!json) return { kind: 'raw', text: raw }
  try {
    const value: unknown = JSON.parse(raw)
    // FastAPI treats a JSON `null` body as no body at all.
    return value === null ? { kind: 'none' } : { kind: 'json', value }
  } catch {
    return { kind: 'invalid-json' }
  }
}
