import { pyJsonDecodeError } from './py-json.ts'
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

/**
 * What `classifyLegacyBody` does not keep: the media type, a JSON `null`
 * body and Python's decode error for invalid JSON. Passed alongside the body
 * (`LegacyRequestContext.bodyDetails`) so the exact shapes above stay stable.
 */
export function describeLegacyBody(
  raw: string | undefined,
  contentType: string | undefined,
): { contentType?: string; jsonNull?: true; error?: string } {
  const mime = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase()
  const out: { contentType?: string; jsonNull?: true; error?: string } = {}
  if (mime !== '') out.contentType = mime
  if (!raw) return out
  const json =
    mime === '' ||
    (mime.startsWith('application/') &&
      (mime === 'application/json' || mime.endsWith('+json')))
  if (!json) return out
  try {
    if (JSON.parse(raw) === null) out.jsonNull = true
  } catch {
    const failure = pyJsonDecodeError(raw)
    if (failure) out.error = failure.msg
  }
  return out
}
