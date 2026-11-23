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

const TOOL_CALL_TIMEOUT_MS = 30_000

async function sendScript(origin: string, script: string) {
  const response = await fetch(
    new URL('/printer/gcode/script', simulatorUrl(origin)),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script }),
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
      redirect: 'error',
    },
  )
  if (!response.ok)
    throw new Error(`Script ${script} failed: ${response.status}`)
  await readBytes(response, 256 * 1024)
}

const ToolState = z.object({
  result: z.object({
    status: z.object({
      toolhead: z.object({ extruder: z.string() }),
      save_variables: z.object({
        variables: z.object({ active_tool: z.number().optional() }),
      }),
    }),
  }),
})

async function queryToolState(origin: string) {
  const response = await fetch(
    new URL(
      '/printer/objects/query?toolhead=extruder&save_variables',
      simulatorUrl(origin),
    ),
    { signal: AbortSignal.timeout(5000), redirect: 'error' },
  )
  if (!response.ok) throw new Error(`Objects query failed: ${response.status}`)
  const { status } = ToolState.parse(await readJson(response)).result
  return {
    extruder: status.toolhead.extruder,
    activeTool: status.save_variables.variables.active_tool,
  }
}

const extruderName = (tool: number) =>
  tool === 0 ? 'extruder' : `extruder${tool}`

export interface ToolSwitchOptions {
  restartTimeoutMs?: number
  pollMs?: number
}

/**
 * Selects T1..T3 on a simulator, checks the active extruder and the saved
 * `active_tool` after each switch, then restarts Klipper and checks that the
 * saved value survived. Klipper does not persist the active extruder, so it
 * resetting to `extruder` is the proof that the restart really happened.
 * Simulators only: this sends G-code.
 */
export async function verifyToolSwitching(
  origin: string,
  { restartTimeoutMs = 120_000, pollMs = 250 }: ToolSwitchOptions = {},
) {
  for (const tool of [1, 2, 3]) {
    await sendScript(origin, `T${tool}`)
    const state = await queryToolState(origin)
    if (state.extruder !== extruderName(tool))
      throw new Error(
        `T${tool}: active extruder is ${state.extruder}, expected ${extruderName(tool)}`,
      )
    if (state.activeTool !== tool)
      throw new Error(
        `T${tool}: saved active_tool is ${state.activeTool}, expected ${tool}`,
      )
  }
  const restart = await fetch(
    new URL('/printer/restart', simulatorUrl(origin)),
    {
      method: 'POST',
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
      redirect: 'error',
    },
  )
  if (!restart.ok) throw new Error(`Restart failed: ${restart.status}`)
  await readBytes(restart, 256 * 1024)
  const deadline = Date.now() + restartTimeoutMs
  while (true) {
    try {
      const state = await queryToolState(origin)
      if (state.extruder === 'extruder') {
        if (state.activeTool !== 3)
          throw new Error(
            `Saved active_tool after restart is ${state.activeTool}, expected 3`,
          )
        return 3
      }
    } catch (error) {
      // Klippy is down mid-restart: the query fails. A wrong saved value is final.
      if (
        error instanceof Error &&
        error.message.startsWith('Saved active_tool')
      )
        throw error
    }
    if (Date.now() >= deadline)
      throw new Error('Klipper did not restart and become ready in time')
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
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
