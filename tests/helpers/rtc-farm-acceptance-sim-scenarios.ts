/**
 * Opt-in farm-page row against the genuine infra/sim simulators (issue #2):
 * the Connector runtime collects from a real Klipper/Moonraker instance and a
 * seeded Spoolman, and the farm page shows that printer's live state and the
 * Spoolman inventory over the existing loopback WebRTC path.
 *
 * Registered only when the runner receives both loopback origins, e.g. for the
 * u1 four-tool simulator and Spoolman started from infra/sim:
 *   RTC_FARM_TEST_SIM_MOONRAKER=http://127.0.0.1:<u1 port>
 *   RTC_FARM_TEST_SIM_SPOOLMAN=http://127.0.0.1:<spoolman port>
 * Start, seed (`pnpm run sim:seed`) and remove the simulators yourself.
 */
import type { RtcFarmScenario } from './rtc-farm-acceptance-scenarios.ts'

function loopbackOrigin(name: string, value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.origin !== value
  )
    throw new Error(`${name} must be an http://127.0.0.1:<port> origin`)
  return value
}

export function simulatorRtcFarmScenarios(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, RtcFarmScenario> {
  const moonraker = env.RTC_FARM_TEST_SIM_MOONRAKER
  const spoolman = env.RTC_FARM_TEST_SIM_SPOOLMAN
  if (!moonraker && !spoolman) return {}
  if (!moonraker || !spoolman)
    throw new Error(
      'Set both RTC_FARM_TEST_SIM_MOONRAKER and RTC_FARM_TEST_SIM_SPOOLMAN',
    )
  return {
    // login → paired Connector on a genuine simulator → live state, tool and bed
    // temperatures and the Spoolman inventory → disconnect → read-only ≤10 s
    'farm-page-simulator-inventory': {
      env: {
        SIGNALLING_HTTPS_RTC_FIXTURE: 'yes',
        SIGNALLING_HTTPS_RTC_RUNTIME: 'yes',
        SIGNALLING_HTTPS_FARM_PAGE: 'yes',
        SIGNALLING_HTTPS_SIM_MOONRAKER: loopbackOrigin(
          'RTC_FARM_TEST_SIM_MOONRAKER',
          moonraker,
        ),
        SIGNALLING_HTTPS_SIM_SPOOLMAN: loopbackOrigin(
          'RTC_FARM_TEST_SIM_SPOOLMAN',
          spoolman,
        ),
      },
      expect: [
        'PASS real generated Nitro HTTPS/WSS admission and authenticated RTC status/closure fixture',
        'authenticated-farm-page-simulator-inventory-and-readonly-degradation',
        'farm-page-simulator-observed:',
        'farm-page-simulator-spools:',
        'farm-page-readonly-after-ms:',
      ],
    },
  }
}

/**
 * Inside the Connector fixture child: the opted-in simulator origins, after a
 * read-only `/server/info` check that Klippy is connected and ready.
 */
export async function readSimulatorSources(env: NodeJS.ProcessEnv) {
  const moonraker = env.SIGNALLING_HTTPS_SIM_MOONRAKER
  const spoolman = env.SIGNALLING_HTTPS_SIM_SPOOLMAN
  if (!moonraker && !spoolman) return null
  if (!moonraker || !spoolman) throw new Error('Simulator sources incomplete')
  const sources = {
    moonraker: loopbackOrigin('SIGNALLING_HTTPS_SIM_MOONRAKER', moonraker),
    spoolman: loopbackOrigin('SIGNALLING_HTTPS_SIM_SPOOLMAN', spoolman),
  }
  const response = await fetch(sources.moonraker + '/server/info', {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  })
  const info = (await response.json()) as {
    result?: { klippy_connected?: unknown; klippy_state?: unknown }
  }
  if (
    !response.ok ||
    info.result?.klippy_connected !== true ||
    info.result.klippy_state !== 'ready'
  )
    throw new Error('Simulator Moonraker is not ready')
  return sources
}
