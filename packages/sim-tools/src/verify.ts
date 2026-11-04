import { readJson, readBytes } from './body.ts'
import { simulatorUrl } from './probe.ts'
import { z } from 'zod'

export async function verifyFourTools(origin: string) {
  const response = await fetch(
    new URL('/printer/objects/list', simulatorUrl(origin)),
    { signal: AbortSignal.timeout(5000), redirect: 'error' },
  )
  if (!response.ok)
    throw new Error(`Objects request failed: ${response.status}`)
  const { result } = z
    .object({ result: z.object({ objects: z.array(z.string()) }) })
    .parse(await readJson(response))
  const required = [
    'extruder',
    'extruder1',
    'extruder2',
    'extruder3',
    'gcode_macro T0',
    'gcode_macro T1',
    'gcode_macro T2',
    'gcode_macro T3',
    'save_variables',
  ]
  for (const name of required)
    if (!result.objects.includes(name))
      throw new Error(`Missing simulated object: ${name}`)
  return required.length
}

export async function verifyWebcam(origin: string) {
  const response = await fetch(
    new URL('/server/webcams/list', simulatorUrl(origin)),
    { signal: AbortSignal.timeout(5000), redirect: 'error' },
  )
  if (!response.ok)
    throw new Error(`Webcams request failed: ${response.status}`)
  const { result } = z
    .object({
      result: z.object({
        webcams: z
          .array(
            z.object({
              snapshot_url: z.string().min(1),
              stream_url: z.string().min(1),
            }),
          )
          .min(1),
      }),
    })
    .parse(await readJson(response))
  return result.webcams.length
}

export async function verifyCamera(origin: string) {
  const response = await fetch(
    new URL('/?action=snapshot', simulatorUrl(origin)),
    { signal: AbortSignal.timeout(5000), redirect: 'error' },
  )
  if (
    !response.ok ||
    !response.headers.get('content-type')?.startsWith('image/jpeg')
  )
    throw new Error('Camera did not return JPEG')
  const bytes = await readBytes(response, 100_000)
  if (
    bytes.length < 4 ||
    bytes.length > 100_000 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    throw new Error('Invalid or oversized test snapshot')
  return bytes.length
}
